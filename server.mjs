import { createServer as createHttpServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import {
  LIMITS,
  PRODUCT_DISCLAIMER,
  applyPayout,
  applyTip,
  applyTopUp,
  clampHouseCutPercent,
  money,
  nyDate,
  summarizeLedger,
  unpaidCents,
} from './ledger.mjs';
import { createOhm } from './ohm.mjs';
import { createStore, hashSecret, newId, verifySecret } from './store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function basePath() {
  const raw = (process.env.BASE_PATH || '').replace(/\/$/, '');
  if (raw && !/^\/[a-z0-9/-]+$/i.test(raw)) {
    throw new Error('BASE_PATH must look like /ohmtracker');
  }
  return raw;
}

function cents(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${label} must be between ${money(min)} and ${money(max)}.`);
  }
  return value;
}

function noteOf(value) {
  const note = String(value || '').trim();
  if (note.length > LIMITS.maxNote) {
    throw new HttpError(400, `Keep the note under ${LIMITS.maxNote} characters.`);
  }
  return note;
}

function handleOf(value) {
  const handle = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(handle) || ['manager', 'admin', 'api', 'ohm', 'studio'].includes(handle)) {
    throw new HttpError(400, 'Handles are 3–20 letters, numbers, or underscores.');
  }
  return handle;
}

function displayNameOf(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > LIMITS.maxDisplayName) {
    throw new HttpError(400, `Display names need 1–${LIMITS.maxDisplayName} characters.`);
  }
  return name;
}

function publicCustomer(customer) {
  return {
    id: customer.id,
    handle: customer.handle,
    creditCents: customer.creditCents,
    createdAt: customer.createdAt,
  };
}

function publicDancer(dancer) {
  return {
    id: dancer.id,
    handle: dancer.handle,
    displayName: dancer.displayName,
    tipCode: dancer.tipCode,
    active: dancer.active !== false,
    earnedCents: dancer.earnedCents,
    paidOutCents: dancer.paidOutCents,
    unpaidCents: unpaidCents(dancer),
    createdAt: dancer.createdAt,
  };
}

function stampEntry(partial, now) {
  return {
    id: newId(8),
    at: now.toISOString(),
    nyDay: nyDate(now),
    status: 'confirmed',
    ...partial,
  };
}

function pushLedger(book, entry) {
  book.ledger.push(entry);
  if (book.ledger.length > LIMITS.maxEntries) {
    book.ledger.splice(0, book.ledger.length - LIMITS.maxEntries);
  }
  return entry;
}

function findCustomer(data, id) {
  const customer = data.customers.find((item) => item.id === id);
  if (!customer) throw new HttpError(404, 'That customer is not on the book.');
  return customer;
}

function findDancer(data, id) {
  const dancer = data.dancers.find((item) => item.id === id);
  if (!dancer) throw new HttpError(404, 'That dancer is not on the book.');
  return dancer;
}

function findDancerByTipCode(data, tipCode) {
  const code = String(tipCode || '').trim().toLowerCase();
  const dancer = data.dancers.find((item) => item.tipCode === code && item.active !== false);
  if (!dancer) throw new HttpError(404, 'That tip code is not active.');
  return dancer;
}

function sessionFrom(data, token, now) {
  if (!token) return null;
  const session = data.sessions.find((item) => item.id === token);
  if (!session) return null;
  if (Date.parse(session.expires) <= now.getTime()) return null;
  return session;
}

function cookieHeader(token, req, base, maxAge) {
  const secure = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `ot_session=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=${base || '/'}`,
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  const match = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('ot_session='));
  return match ? decodeURIComponent(match.slice('ot_session='.length)) : '';
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readBody(req, maxBytes = 20_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'That request is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Send JSON.');
  }
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'local';
}

function createLimiter() {
  const hits = new Map();
  return function limit(key, max, windowMs) {
    const now = Date.now();
    const bucket = (hits.get(key) || []).filter((at) => now - at < windowMs);
    if (bucket.length >= max) {
      throw new HttpError(429, 'Slow down and try again in a few minutes.');
    }
    bucket.push(now);
    hits.set(key, bucket);
  };
}

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

async function absoluteUrl(req, base, pathname) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1';
  return `${proto}://${host}${base}${pathname}`;
}

function managerSummary(book) {
  const summary = summarizeLedger(book.ledger);
  return {
    ...summary,
    customerCreditsCents: book.customers.reduce((sum, c) => sum + c.creditCents, 0),
    dancerUnpaidCents: book.dancers.reduce((sum, d) => sum + unpaidCents(d), 0),
    customers: book.customers.length,
    dancers: book.dancers.filter((d) => d.active !== false).length,
  };
}

export function createServer(options = {}) {
  const base = options.basePath ?? basePath();
  const dataFile = options.dataFile || path.join(__dirname, 'data', 'book.json');
  const store = options.store || createStore(dataFile);
  const ohm = options.ohm || createOhm();
  const pin = options.pin ?? process.env.OHM_MANAGER_PIN ?? '';
  let pinHash = null;
  const limit = createLimiter();
  const ready = (async () => {
    await store.load();
    if (pin) pinHash = await hashSecret(pin);
  })();

  function requirePinConfigured() {
    if (!pinHash) {
      throw new HttpError(503, 'The manager pin is not set on this server yet.');
    }
  }

  async function settleInvoice(data, invoice, now, { samplePay = false } = {}) {
    if (invoice.status === 'paid') return invoice;
    if (invoice.mode === 'live') {
      const checked = await ohm.checkInvoice(invoice.paymentHashHex);
      if (checked.status === 'pending') return invoice;
      if (checked.status !== 'paid') {
        invoice.status = checked.status;
        return invoice;
      }
    } else if (invoice.mode === 'sandbox') {
      if (!samplePay) return invoice;
    } else {
      return invoice;
    }
    const customer = findCustomer(data, invoice.customerId);
    applyTopUp(customer, invoice.amountCents);
    pushLedger(
      data,
      stampEntry(
        {
          kind: 'topup',
          amountCents: invoice.amountCents,
          customerId: customer.id,
          handle: customer.handle,
          source: 'ohm',
          method: invoice.mode === 'live' ? 'ohm' : 'sandbox',
          note: invoice.note || 'Credit top-up',
          invoiceId: invoice.id,
        },
        now,
      ),
    );
    invoice.status = 'paid';
    invoice.paidAt = now.toISOString();
    return invoice;
  }

  async function handle(req, res) {
    await ready;
    const now = options.now ? options.now() : new Date();
    const url = new URL(req.url || '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (base) {
      if (pathname !== base && !pathname.startsWith(`${base}/`)) {
        send(res, 404, { error: 'Not found.' });
        return;
      }
      pathname = pathname.slice(base.length) || '/';
    }
    if (req.method === 'POST' && !originAllowed(req)) {
      send(res, 403, { error: 'That request came from somewhere else.' });
      return;
    }

    const data = () => store.snapshot();
    const token = readCookie(req);
    const ip = clientIp(req);

    const routes = {
      'GET /api/health': async () => ({ ok: true, checkout: ohm.mode() }),

      'GET /api/public': async () => {
        const book = data();
        return {
          brand: 'Ohm',
          product: 'Ohm Tracker',
          clubName: book.settings.clubName,
          checkout: ohm.mode(),
          packages: book.settings.packages,
          topUpCode: book.settings.topUpCode,
          houseCutPercent: book.settings.houseCutPercent,
          disclaimer: book.settings.disclaimer || PRODUCT_DISCLAIMER,
          limits: LIMITS,
          dancers: book.dancers.filter((d) => d.active !== false).map((d) => ({
            displayName: d.displayName,
            tipCode: d.tipCode,
          })),
        };
      },

      'GET /api/session': async () => {
        const session = sessionFrom(data(), token, now);
        if (!session) return { role: null };
        if (session.role === 'manager') {
          const book = data();
          return {
            role: 'manager',
            clubName: book.settings.clubName,
            houseCutPercent: book.settings.houseCutPercent,
            topUpCode: book.settings.topUpCode,
            packages: book.settings.packages,
            disclaimer: book.settings.disclaimer || PRODUCT_DISCLAIMER,
            summary: managerSummary(book),
            dancers: book.dancers.map(publicDancer),
            customers: book.customers.map(publicCustomer),
            ledger: book.ledger.slice(-200).reverse(),
          };
        }
        if (session.role === 'customer') {
          const customer = data().customers.find((item) => item.id === session.customerId);
          if (!customer) return { role: null };
          const mine = data()
            .ledger.filter((entry) => entry.customerId === customer.id)
            .slice(-100)
            .reverse();
          return { role: 'customer', customer: publicCustomer(customer), ledger: mine };
        }
        if (session.role === 'dancer') {
          const dancer = data().dancers.find((item) => item.id === session.dancerId);
          if (!dancer) return { role: null };
          const mine = data()
            .ledger.filter((entry) => entry.dancerId === dancer.id)
            .slice(-100)
            .reverse();
          return { role: 'dancer', dancer: publicDancer(dancer), ledger: mine };
        }
        return { role: null };
      },

      'POST /api/manager/login': async () => {
        requirePinConfigured();
        limit(`mgr:${ip}`, 12, 15 * 60 * 1000);
        const body = await readBody(req);
        const ok = await verifySecret(String(body.pin || ''), pinHash.salt, pinHash.hash);
        if (!ok) throw new HttpError(401, 'That manager pin is wrong.');
        const session = {
          id: newId(24),
          role: 'manager',
          expires: new Date(now.getTime() + SESSION_MS).toISOString(),
        };
        await store.update((book) => {
          book.sessions.push(session);
          book.sessions = book.sessions.filter((item) => Date.parse(item.expires) > now.getTime());
        });
        return {
          role: 'manager',
          headers: { 'Set-Cookie': cookieHeader(session.id, req, base, SESSION_MS / 1000) },
        };
      },

      'POST /api/logout': async () => {
        await store.update((book) => {
          book.sessions = book.sessions.filter((item) => item.id !== token);
        });
        return {
          ok: true,
          headers: { 'Set-Cookie': cookieHeader('', req, base, 0) },
        };
      },

      'POST /api/customer/join': async () => {
        limit(`join:${ip}`, 10, 15 * 60 * 1000);
        const body = await readBody(req);
        if (body.adult !== true) throw new HttpError(400, 'Confirm you are 18 or older.');
        const handle = handleOf(body.handle);
        const passphrase = String(body.passphrase || '');
        if (passphrase.length < LIMITS.minPassphrase || passphrase.length > LIMITS.maxPassphrase) {
          throw new HttpError(400, 'Use a passphrase of at least 8 characters.');
        }
        const secret = await hashSecret(passphrase);
        const session = {
          id: newId(24),
          role: 'customer',
          expires: new Date(now.getTime() + SESSION_MS).toISOString(),
        };
        const customer = await store.update(async (book) => {
          if (book.customers.length >= LIMITS.maxCustomers) {
            throw new HttpError(400, 'This club is not taking new customer accounts.');
          }
          if (book.customers.some((item) => item.handle === handle)) {
            throw new HttpError(409, 'That handle is taken. Sign in instead.');
          }
          if (book.dancers.some((item) => item.handle === handle)) {
            throw new HttpError(409, 'That handle belongs to a dancer.');
          }
          const created = {
            id: newId(8),
            handle,
            passSalt: secret.salt,
            passHash: secret.hash,
            creditCents: 0,
            createdAt: now.toISOString(),
          };
          book.customers.push(created);
          session.customerId = created.id;
          book.sessions.push(session);
          return created;
        });
        return {
          role: 'customer',
          customer: publicCustomer(customer),
          headers: { 'Set-Cookie': cookieHeader(session.id, req, base, SESSION_MS / 1000) },
        };
      },

      'POST /api/customer/login': async () => {
        limit(`clogin:${ip}`, 20, 15 * 60 * 1000);
        const body = await readBody(req);
        const handle = handleOf(body.handle);
        const passphrase = String(body.passphrase || '');
        const customer = data().customers.find((item) => item.handle === handle);
        if (!customer) throw new HttpError(401, 'Handle or passphrase is wrong.');
        const ok = await verifySecret(passphrase, customer.passSalt, customer.passHash);
        if (!ok) throw new HttpError(401, 'Handle or passphrase is wrong.');
        const session = {
          id: newId(24),
          role: 'customer',
          customerId: customer.id,
          expires: new Date(now.getTime() + SESSION_MS).toISOString(),
        };
        await store.update((book) => {
          book.sessions.push(session);
        });
        return {
          role: 'customer',
          customer: publicCustomer(customer),
          headers: { 'Set-Cookie': cookieHeader(session.id, req, base, SESSION_MS / 1000) },
        };
      },

      'POST /api/dancer/login': async () => {
        limit(`dlogin:${ip}`, 20, 15 * 60 * 1000);
        const body = await readBody(req);
        const handle = handleOf(body.handle);
        const passphrase = String(body.passphrase || '');
        const dancer = data().dancers.find((item) => item.handle === handle);
        if (!dancer || dancer.active === false) throw new HttpError(401, 'Handle or passphrase is wrong.');
        const ok = await verifySecret(passphrase, dancer.passSalt, dancer.passHash);
        if (!ok) throw new HttpError(401, 'Handle or passphrase is wrong.');
        const session = {
          id: newId(24),
          role: 'dancer',
          dancerId: dancer.id,
          expires: new Date(now.getTime() + SESSION_MS).toISOString(),
        };
        await store.update((book) => {
          book.sessions.push(session);
        });
        return {
          role: 'dancer',
          dancer: publicDancer(dancer),
          headers: { 'Set-Cookie': cookieHeader(session.id, req, base, SESSION_MS / 1000) },
        };
      },

      'POST /api/manager/settings': async () => {
        const session = sessionFrom(data(), token, now);
        if (session?.role !== 'manager') throw new HttpError(401, 'Manager sign-in required.');
        const body = await readBody(req);
        const book = await store.update((current) => {
          if (body.clubName != null) {
            const name = String(body.clubName || '').trim().slice(0, 60);
            if (!name) throw new HttpError(400, 'Club name cannot be empty.');
            current.settings.clubName = name;
          }
          if (body.houseCutPercent != null) {
            try {
              current.settings.houseCutPercent = clampHouseCutPercent(body.houseCutPercent);
            } catch (error) {
              throw new HttpError(400, error.message);
            }
          }
          if (body.rotateTopUpCode === true) {
            current.settings.topUpCode = newId(4);
          }
          return current.settings;
        });
        return {
          clubName: book.clubName,
          houseCutPercent: book.houseCutPercent,
          topUpCode: book.topUpCode,
        };
      },

      'POST /api/manager/dancers': async () => {
        const session = sessionFrom(data(), token, now);
        if (session?.role !== 'manager') throw new HttpError(401, 'Manager sign-in required.');
        const body = await readBody(req);
        const handle = handleOf(body.handle);
        const displayName = displayNameOf(body.displayName || body.handle);
        const passphrase = String(body.passphrase || '');
        if (passphrase.length < LIMITS.minPassphrase || passphrase.length > LIMITS.maxPassphrase) {
          throw new HttpError(400, 'Use a passphrase of at least 8 characters.');
        }
        const secret = await hashSecret(passphrase);
        const dancer = await store.update(async (book) => {
          if (book.dancers.length >= LIMITS.maxDancers) {
            throw new HttpError(400, 'Dancer roster is full.');
          }
          if (book.dancers.some((item) => item.handle === handle) || book.customers.some((item) => item.handle === handle)) {
            throw new HttpError(409, 'That handle is already in use.');
          }
          const created = {
            id: newId(8),
            handle,
            displayName,
            tipCode: newId(4),
            passSalt: secret.salt,
            passHash: secret.hash,
            earnedCents: 0,
            paidOutCents: 0,
            active: true,
            createdAt: now.toISOString(),
          };
          book.dancers.push(created);
          return created;
        });
        return { dancer: publicDancer(dancer) };
      },

      'POST /api/manager/dancers/rotate-tip': async () => {
        const session = sessionFrom(data(), token, now);
        if (session?.role !== 'manager') throw new HttpError(401, 'Manager sign-in required.');
        const body = await readBody(req);
        const dancer = await store.update((book) => {
          const current = findDancer(book, body.dancerId);
          current.tipCode = newId(4);
          return current;
        });
        return { dancer: publicDancer(dancer) };
      },

      'POST /api/manager/dancers/active': async () => {
        const session = sessionFrom(data(), token, now);
        if (session?.role !== 'manager') throw new HttpError(401, 'Manager sign-in required.');
        const body = await readBody(req);
        const dancer = await store.update((book) => {
          const current = findDancer(book, body.dancerId);
          current.active = body.active !== false;
          return current;
        });
        return { dancer: publicDancer(dancer) };
      },

      'POST /api/manager/payout': async () => {
        const session = sessionFrom(data(), token, now);
        if (session?.role !== 'manager') throw new HttpError(401, 'Manager sign-in required.');
        const body = await readBody(req);
        const amountCents = cents(body.amountCents, 1, LIMITS.maxPayoutCents, 'Payout');
        const note = noteOf(body.note);
        const result = await store.update((book) => {
          const dancer = findDancer(book, body.dancerId);
          try {
            applyPayout(dancer, amountCents);
          } catch (error) {
            throw new HttpError(400, error.message);
          }
          const entry = pushLedger(
            book,
            stampEntry(
              {
                kind: 'payout',
                amountCents,
                dancerId: dancer.id,
                dancerHandle: dancer.handle,
                displayName: dancer.displayName,
                note: note || 'Dancer payout',
                source: 'manager',
              },
              now,
            ),
          );
          return { dancer: publicDancer(dancer), entry };
        });
        return result;
      },

      'POST /api/manager/credit': async () => {
        const session = sessionFrom(data(), token, now);
        if (session?.role !== 'manager') throw new HttpError(401, 'Manager sign-in required.');
        const body = await readBody(req);
        const amountCents = cents(body.amountCents, 1, LIMITS.maxCheckoutCents, 'Credit');
        const note = noteOf(body.note);
        const result = await store.update((book) => {
          const customer = findCustomer(book, body.customerId);
          applyTopUp(customer, amountCents);
          const entry = pushLedger(
            book,
            stampEntry(
              {
                kind: 'topup',
                amountCents,
                customerId: customer.id,
                handle: customer.handle,
                source: 'manager',
                method: 'manual',
                note: note || 'Manual credit',
              },
              now,
            ),
          );
          return { customer: publicCustomer(customer), entry };
        });
        return result;
      },

      'GET /api/topup/info': async () => {
        const book = data();
        const code = String(url.searchParams.get('code') || '').trim().toLowerCase();
        if (code && code !== book.settings.topUpCode) {
          throw new HttpError(404, 'That top-up code is not valid.');
        }
        return {
          clubName: book.settings.clubName,
          topUpCode: book.settings.topUpCode,
          packages: book.settings.packages,
          checkout: ohm.mode(),
          disclaimer: book.settings.disclaimer || PRODUCT_DISCLAIMER,
        };
      },

      'GET /api/tip/info': async () => {
        const tipCode = String(url.searchParams.get('code') || '').trim().toLowerCase();
        const dancer = findDancerByTipCode(data(), tipCode);
        return {
          clubName: data().settings.clubName,
          dancer: {
            displayName: dancer.displayName,
            tipCode: dancer.tipCode,
          },
          houseCutPercent: data().settings.houseCutPercent,
          disclaimer: data().settings.disclaimer || PRODUCT_DISCLAIMER,
        };
      },

      'POST /api/checkout/topup': async () => {
        limit(`topup:${ip}`, 30, 15 * 60 * 1000);
        const session = sessionFrom(data(), token, now);
        if (session?.role !== 'customer') throw new HttpError(401, 'Customer sign-in required to top up.');
        const body = await readBody(req);
        const book = data();
        const code = String(body.code || book.settings.topUpCode).trim().toLowerCase();
        if (code !== book.settings.topUpCode) throw new HttpError(404, 'That top-up code is not valid.');
        let amountCents = body.amountCents;
        if (body.packageId) {
          const pack = book.settings.packages.find((item) => item.id === body.packageId);
          if (!pack) throw new HttpError(400, 'Unknown package.');
          amountCents = pack.amountCents;
        }
        amountCents = cents(amountCents, LIMITS.minCheckoutCents, LIMITS.maxCheckoutCents, 'Top-up');
        const customer = findCustomer(book, session.customerId);
        const mode = ohm.mode();
        let invoicePayload;
        if (mode === 'live') {
          invoicePayload = await ohm.createInvoice({
            amountCents,
            memo: `Ohm ${book.settings.clubName} top-up`,
          });
        } else {
          invoicePayload = {
            mode: 'sandbox',
            bolt11: `lnsandbox${newId(20)}`,
            paymentHashHex: newId(32),
            amountSats: 0,
            btcUsd: 0,
            expiresAt: new Date(now.getTime() + 3600 * 1000).toISOString(),
          };
        }
        const invoice = await store.update((current) => {
          const row = {
            id: newId(8),
            kind: 'topup',
            customerId: customer.id,
            amountCents,
            status: 'pending',
            mode: invoicePayload.mode,
            bolt11: invoicePayload.bolt11,
            paymentHashHex: invoicePayload.paymentHashHex,
            amountSats: invoicePayload.amountSats || 0,
            note: noteOf(body.note) || 'Credit top-up',
            createdAt: now.toISOString(),
            expiresAt: invoicePayload.expiresAt,
          };
          current.invoices.push(row);
          return row;
        });
        const qrDataUrl = await QRCode.toDataURL(invoice.bolt11, { margin: 1, width: 280 });
        return {
          invoice: {
            id: invoice.id,
            amountCents: invoice.amountCents,
            mode: invoice.mode,
            bolt11: invoice.bolt11,
            status: invoice.status,
            expiresAt: invoice.expiresAt,
            qrDataUrl,
          },
          sample: invoice.mode === 'sandbox',
        };
      },

      'POST /api/checkout/settle': async () => {
        const body = await readBody(req);
        const invoiceId = String(body.invoiceId || '');
        const result = await store.update(async (book) => {
          const invoice = book.invoices.find((item) => item.id === invoiceId);
          if (!invoice) throw new HttpError(404, 'Unknown invoice.');
          await settleInvoice(book, invoice, now, { samplePay: body.samplePay === true });
          const customer = findCustomer(book, invoice.customerId);
          return {
            invoice: {
              id: invoice.id,
              status: invoice.status,
              amountCents: invoice.amountCents,
              paidAt: invoice.paidAt || null,
            },
            customer: publicCustomer(customer),
          };
        });
        return result;
      },

      'POST /api/tip': async () => {
        limit(`tip:${ip}`, 40, 15 * 60 * 1000);
        const session = sessionFrom(data(), token, now);
        if (session?.role !== 'customer') throw new HttpError(401, 'Customer sign-in required to tip.');
        const body = await readBody(req);
        const amountCents = cents(body.amountCents, 1, LIMITS.maxTipCents, 'Tip');
        const note = noteOf(body.note);
        const result = await store.update((book) => {
          const customer = findCustomer(book, session.customerId);
          const dancer = findDancerByTipCode(book, body.tipCode);
          let split;
          try {
            split = applyTip(customer, dancer, amountCents, book.settings.houseCutPercent);
          } catch (error) {
            throw new HttpError(400, error.message);
          }
          const entry = pushLedger(
            book,
            stampEntry(
              {
                kind: 'tip',
                amountCents: split.amountCents,
                houseCents: split.houseCents,
                dancerCents: split.dancerCents,
                houseCutPercent: split.houseCutPercent,
                customerId: customer.id,
                handle: customer.handle,
                dancerId: dancer.id,
                dancerHandle: dancer.handle,
                displayName: dancer.displayName,
                note: note || `Tip to ${dancer.displayName}`,
                source: 'customer',
              },
              now,
            ),
          );
          return {
            entry,
            customer: publicCustomer(customer),
            dancer: {
              displayName: dancer.displayName,
              tipCode: dancer.tipCode,
            },
            split,
          };
        });
        return result;
      },

      'GET /api/qr/topup': async () => {
        const session = sessionFrom(data(), token, now);
        if (session?.role !== 'manager') throw new HttpError(401, 'Manager sign-in required.');
        const book = data();
        const target = await absoluteUrl(req, base, `/u/${book.settings.topUpCode}`);
        const qrDataUrl = await QRCode.toDataURL(target, { margin: 1, width: 320 });
        return { url: target, qrDataUrl, code: book.settings.topUpCode };
      },

      'GET /api/qr/tip': async () => {
        const tipCode = String(url.searchParams.get('code') || '').trim().toLowerCase();
        const dancer = findDancerByTipCode(data(), tipCode);
        const session = sessionFrom(data(), token, now);
        const allowed =
          session?.role === 'manager' ||
          (session?.role === 'dancer' && session.dancerId === dancer.id);
        if (!allowed) throw new HttpError(401, 'Sign in as manager or that dancer to show the tip QR.');
        const target = await absoluteUrl(req, base, `/tip/${dancer.tipCode}`);
        const qrDataUrl = await QRCode.toDataURL(target, { margin: 1, width: 320 });
        return {
          url: target,
          qrDataUrl,
          dancer: { displayName: dancer.displayName, tipCode: dancer.tipCode },
        };
      },
    };

    const key = `${req.method} ${pathname}`;
    if (routes[key]) {
      try {
        const result = await routes[key]();
        const headers = result?.headers || {};
        const body = { ...result };
        delete body.headers;
        send(res, 200, body, headers);
      } catch (error) {
        if (error instanceof HttpError) {
          send(res, error.status, { error: error.message });
          return;
        }
        console.error('ohmtracker', error);
        send(res, 500, { error: 'Something went wrong.' });
      }
      return;
    }

    // SPA routes
    const spa =
      pathname === '/' ||
      pathname === '/manager' ||
      pathname === '/account' ||
      pathname === '/dancer' ||
      pathname.startsWith('/u/') ||
      pathname.startsWith('/tip/');

    let filePath = null;
    if (spa) filePath = path.join(PUBLIC_DIR, 'index.html');
    else if (pathname.startsWith('/')) {
      const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      filePath = path.join(PUBLIC_DIR, safe);
      if (!filePath.startsWith(PUBLIC_DIR)) {
        send(res, 404, { error: 'Not found.' });
        return;
      }
    }

    if (!filePath) {
      send(res, 404, { error: 'Not found.' });
      return;
    }

    try {
      let content = await readFile(filePath);
      if (filePath.endsWith('.html')) {
        content = Buffer.from(String(content).replaceAll('%%BASE%%', base), 'utf8');
      }
      res.writeHead(200, {
        'Content-Type': contentType(filePath),
        'Cache-Control': filePath.endsWith('.html') ? 'no-store' : 'public, max-age=3600',
      });
      res.end(content);
    } catch {
      send(res, 404, { error: 'Not found.' });
    }
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error('ohmtracker', error);
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong.' });
    });
  });

  return {
    server,
    store,
    listen(port = Number(process.env.PORT) || 8791, host = process.env.HOST || '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve({ port, host }));
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const pin = process.env.OHM_MANAGER_PIN;
  if (!pin) {
    console.error('Set OHM_MANAGER_PIN before starting Ohm Tracker.');
    process.exit(1);
  }
  await mkdir(path.join(__dirname, 'data'), { recursive: true });
  const app = createServer();
  const { port, host } = await app.listen();
  console.log(`Ohm Tracker on http://${host}:${port}`);
}
