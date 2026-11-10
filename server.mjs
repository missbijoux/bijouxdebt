import { createServer as createHttpServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import {
  acceptGame,
  assertPlayable,
  ATM_OPTIONS,
  atmLocked,
  atmOdds,
  atmView,
  defaultAtmTerms,
  defaultSlotTerms,
  drawKick,
  drawSkim,
  drawSlot,
  effectiveLimits,
  GameError,
  gameKeyOf,
  GAMES,
  gameView,
  newGame,
  normalizeStanding,
  normalizeTerms,
  reviseGame,
  setSubLimits,
  slotOdds,
  slotOutcomeIndex,
  SLOT_SYMBOLS,
  standingView,
  trimPlays,
  upgradeSub,
} from './games.mjs';
import { accrue, applyConfirmedPayment, LIMITS, money, nextDueLabel, nyDate } from './ledger.mjs';
import {
  addNotice,
  deliverNotice,
  ensureVapid,
  markNoticesRead,
  publicNotice,
  removePushSubscription,
  savePushSubscription,
  unreadNotices,
  vapidKeys,
} from './notify.mjs';
import { createOhm } from './ohm.mjs';
import { cleanScreenshot, PROOF_TYPES, ProofError, referenceOf } from './proof.mjs';
import { createStore, hashSecret, newId, TITLES, verifySecret } from './store.mjs';

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
    throw new Error('BASE_PATH must look like /bijouxdebt');
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
  if (!/^[a-z0-9_]{3,20}$/.test(handle) || ['studio', 'admin', 'api', 'bijoux'].includes(handle)) {
    throw new HttpError(400, 'Use 3 to 20 letters, numbers, or underscores.');
  }
  return handle;
}

function titleOf(value) {
  const title = String(value || 'sub');
  if (!TITLES.includes(title)) throw new HttpError(400, 'Pick one of the titles on the form.');
  return title;
}

function publicSub(sub) {
  return {
    id: sub.id,
    handle: sub.handle,
    title: sub.title,
    sentCents: sub.sentCents,
    hideFromHall: sub.hideFromHall,
  };
}

function privateSub(sub, now) {
  const debt = sub.debt
    ? {
        status: sub.debt.status,
        principalCents: sub.debt.principalCents,
        balanceCents: sub.debt.balanceCents,
        apr: sub.debt.apr,
        lateFeeCents: sub.debt.lateFeeCents,
        minPaymentCents: sub.debt.minPaymentCents,
        dueDay: sub.debt.dueDay,
        signedAt: sub.debt.signedAt || null,
        nextDue: nextDueLabel(sub.debt, now),
      }
    : null;
  return {
    id: sub.id,
    handle: sub.handle,
    title: sub.title,
    createdAt: sub.createdAt,
    sentCents: sub.sentCents,
    tributeCents: sub.tributeCents,
    askCents: sub.askCents,
    hideFromHall: sub.hideFromHall,
    debt,
    tasks: sub.tasks,
    games: {
      slot: gameView(sub, 'slot', now, nyDate(now)),
      atm: gameView(sub, 'atm', now, nyDate(now)),
    },
    standing: standingView(sub, nyDate(now)),
    atm: atmView(sub.atm, now),
    entries: sub.entries.slice(-200),
  };
}

function playIdOf(value) {
  const id = String(value || '');
  if (!/^[a-f0-9]{16,64}$/.test(id)) throw new HttpError(400, 'Each play needs its own id.');
  return id;
}

function priorPlay(sub, playId, key) {
  const prior = sub.plays.find((play) => play.id === playId);
  if (prior && prior.game !== key) throw new HttpError(409, 'That play id belongs to another game.');
  return prior || null;
}

/** The one place a game result touches money. It can only raise an active signed debt. */
function recordPlay(sub, play, now) {
  if (!Number.isInteger(play.amountCents) || play.amountCents <= 0) {
    throw new HttpError(500, 'A game result must be a positive charge.');
  }
  if (sub.debt?.status !== 'active') throw new HttpError(400, 'Games only add to an active signed debt.');
  const before = sub.debt.balanceCents;
  sub.debt.balanceCents += play.amountCents;
  const entry = pushEntry(sub, stampEntry({
    kind: 'game',
    game: play.game,
    outcome: play.label,
    amountCents: play.amountCents,
    purpose: 'debt',
    source: 'game',
    note: `${GAMES[play.game]}: ${play.label}`,
    playId: play.id,
  }, now));
  const saved = {
    ...play,
    at: entry.at,
    nyDay: entry.nyDay,
    entryId: entry.id,
    balanceBeforeCents: before,
    balanceAfterCents: sub.debt.balanceCents,
  };
  sub.plays.push(saved);
  trimPlays(sub.plays, entry.nyDay);
  return saved;
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

function pushEntry(sub, entry) {
  if (sub.entries.length >= LIMITS.maxEntries) {
    throw new HttpError(400, 'This book is full. Settle it before adding more lines.');
  }
  sub.entries.push(entry);
  return entry;
}

function note(book, partial, now, bag) {
  const notice = addNotice(book, partial, now);
  bag.push(notice);
  return notice;
}

function releaseNotices(store, notices) {
  for (const notice of notices) {
    (async () => {
      try {
        const result = await deliverNotice(store.snapshot(), notice);
        if (result.push?.pruned) await store.update(() => {});
      } catch (error) {
        console.error('bijouxdebt notify', error instanceof Error ? error.message : 'error');
      }
    })();
  }
}

async function mutate(store, work) {
  const notices = [];
  const result = await store.update((book) => work(book, notices));
  releaseNotices(store, notices);
  return result;
}

function accrueSub(sub, now) {
  const added = accrue(sub, now);
  for (const partial of added) pushEntry(sub, stampEntry(partial, now));
}

function findSub(data, id) {
  const sub = data.subs.find((item) => item.id === id);
  if (!sub) throw new HttpError(404, 'That name is not in the book.');
  return sub;
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
    `bd_session=${token}`,
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
  const match = header.split(';').map((part) => part.trim()).find((part) => part.startsWith('bd_session='));
  return match ? decodeURIComponent(match.slice('bd_session='.length)) : '';
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

function hallOf(data) {
  return data.subs
    .filter((sub) => !sub.hideFromHall && sub.sentCents > 0)
    .sort((a, b) => b.sentCents - a.sentCents || a.handle.localeCompare(b.handle))
    .slice(0, 12)
    .map((sub) => ({ handle: sub.handle, title: sub.title, sentCents: sub.sentCents }));
}

function monthSent(sub, month) {
  return sub.entries.reduce((sum, entry) => {
    if (entry.status !== 'confirmed') return sum;
    if (entry.kind !== 'payment' && entry.kind !== 'tribute') return sum;
    if (!String(entry.nyDay || '').startsWith(month)) return sum;
    return sum + entry.amountCents;
  }, 0);
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

export function createServer(options = {}) {
  const base = options.basePath ?? basePath();
  const dataFile = options.dataFile || path.join(__dirname, 'data', 'book.json');
  const store = options.store || createStore(dataFile);
  const proofDir = options.proofDir || path.join(path.dirname(dataFile), 'proofs');
  const ohm = options.ohm || createOhm();
  const pin = options.pin ?? process.env.BIJOUX_STUDIO_PIN ?? '';
  let pinHash = null;
  const limit = createLimiter();
  const ready = (async () => {
    await store.load();
    if (pin) pinHash = await hashSecret(pin);
  })();

  function requirePinConfigured() {
    if (!pinHash) {
      throw new HttpError(503, 'The studio pin is not set on this server yet.');
    }
  }

  async function settleInvoice(data, invoice, now) {
    if (invoice.status === 'paid') return invoice;
    if (invoice.mode === 'live') {
      const checked = await ohm.checkInvoice(invoice.paymentHashHex);
      if (checked.status === 'pending') return invoice;
      if (checked.status !== 'paid') {
        invoice.status = checked.status;
        return invoice;
      }
    }
    if (invoice.status === 'paid') return invoice;
    const sub = findSub(data, invoice.subId);
    accrueSub(sub, now);
    const applied = applyConfirmedPayment(sub, invoice.amountCents, invoice.purpose);
    pushEntry(
      sub,
      stampEntry(
        {
          kind: applied.purpose === 'debt' ? 'payment' : 'tribute',
          amountCents: invoice.amountCents,
          purpose: applied.purpose,
          source: 'ohm',
          method: invoice.mode === 'live' ? 'ohm' : 'sandbox',
          note: invoice.note,
          ...applied,
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
      'GET /api/public': async () => ({
        name: 'Dominatrix Bijoux',
        checkout: ohm.mode(),
        titles: TITLES,
        tiers: data().settings.tiers,
        hall: hallOf(data()),
        names: data().subs.length,
        sentCents: data().subs.reduce((sum, sub) => sum + sub.sentCents, 0),
        limits: LIMITS,
      }),
      'GET /api/session': async () => {
        const session = sessionFrom(data(), token, now);
        if (!session) return { role: null };
        if (session.role === 'studio') return { role: 'studio' };
        const sub = data().subs.find((item) => item.id === session.subId);
        if (!sub) return { role: null };
        return store.update((book) => {
          const current = findSub(book, sub.id);
          accrueSub(current, now);
          return { role: 'sub', sub: privateSub(current, now) };
        });
      },
      'POST /api/join': async () => {
        limit(`join:${ip}`, 8, 15 * 60 * 1000);
        const body = await readBody(req);
        if (body.adult !== true) throw new HttpError(400, 'You have to confirm you are 18 or older.');
        const handle = handleOf(body.handle);
        const title = titleOf(body.title);
        const passphrase = String(body.passphrase || '');
        if (passphrase.length < LIMITS.minPassphrase || passphrase.length > LIMITS.maxPassphrase) {
          throw new HttpError(400, 'Use a passphrase of at least 8 characters.');
        }
        const result = await store.update(async (book) => {
          if (book.subs.length >= LIMITS.maxSubs) throw new HttpError(400, 'The book is not taking new names.');
          if (book.subs.some((sub) => sub.handle === handle)) {
            throw new HttpError(409, 'That name is already in the book. Sign in instead.');
          }
          const secret = await hashSecret(passphrase);
          const sub = {
            id: newId(8),
            handle,
            title,
            passSalt: secret.salt,
            passHash: secret.hash,
            createdAt: now.toISOString(),
            sentCents: 0,
            tributeCents: 0,
            askCents: 0,
            hideFromHall: false,
            debt: null,
            tasks: [],
            entries: [],
          };
          upgradeSub(sub);
          book.subs.push(sub);
          const session = { id: newId(32), role: 'sub', subId: sub.id, expires: new Date(now.getTime() + SESSION_MS).toISOString() };
          book.sessions.push(session);
          return { sessionId: session.id, sub: privateSub(sub, now) };
        });
        res.setHeader('Set-Cookie', cookieHeader(result.sessionId, req, base, SESSION_MS / 1000));
        return { role: 'sub', sub: result.sub };
      },
      'POST /api/login': async () => {
        limit(`login:${ip}`, 10, 15 * 60 * 1000);
        const body = await readBody(req);
        const handle = String(body.handle || '').trim().toLowerCase();
        const passphrase = String(body.passphrase || '');
        const sub = /^[a-z0-9_]{3,20}$/.test(handle)
          ? data().subs.find((item) => item.handle === handle)
          : null;
        const ok = sub ? await verifySecret(passphrase, sub.passSalt, sub.passHash) : false;
        if (!ok) throw new HttpError(401, 'That name or passphrase does not match.');
        const result = await store.update((book) => {
          const current = findSub(book, sub.id);
          accrueSub(current, now);
          const session = { id: newId(32), role: 'sub', subId: current.id, expires: new Date(now.getTime() + SESSION_MS).toISOString() };
          book.sessions.push(session);
          return { sessionId: session.id, sub: privateSub(current, now) };
        });
        res.setHeader('Set-Cookie', cookieHeader(result.sessionId, req, base, SESSION_MS / 1000));
        return { role: 'sub', sub: result.sub };
      },
      'POST /api/logout': async () => {
        await store.update((book) => {
          book.sessions = book.sessions.filter((session) => session.id !== token);
        });
        res.setHeader('Set-Cookie', cookieHeader('', req, base, 0));
        return { role: null };
      },
      'POST /api/me/sign': async () => {
        const session = requireSub(data(), token, now);
        return mutate(store, (book, notices) => {
          const sub = findSub(book, session.subId);
          if (sub.debt?.status !== 'proposed') throw new HttpError(400, 'There is no debt waiting for your signature.');
          sub.debt.status = 'active';
          sub.debt.balanceCents = sub.debt.principalCents;
          sub.debt.signedAt = now.toISOString();
          sub.debt.accruedThrough = nyDate(now);
          sub.debt.lateFeesApplied = [];
          pushEntry(sub, stampEntry({
            kind: 'principal',
            amountCents: sub.debt.principalCents,
            purpose: 'debt',
            source: 'sub',
            note: 'Debt signed',
          }, now));
          note(book, {
            audience: 'studio',
            subId: sub.id,
            handle: sub.handle,
            kind: 'debt_signed',
            title: `${sub.handle} signed the debt`,
            body: `${money(sub.debt.principalCents)} is active now.`,
            href: '/studio',
          }, now, notices);
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/me/claim': async () => {
        limit(`claim:${ip}`, 10, 15 * 60 * 1000);
        const session = requireSub(data(), token, now);
        const body = await readBody(req, 4_300_000);
        const amount = cents(body.amountCents, LIMITS.minCheckoutCents, LIMITS.maxCheckoutCents, 'A claim');
        const purpose = body.purpose === 'debt' ? 'debt' : 'tribute';
        const text = noteOf(body.note) || 'Claimed outside the book';
        const reference = referenceOf(body.reference);
        const screenshot = body.screenshot ? cleanScreenshot(body.screenshot) : null;
        if (!reference && !screenshot) {
          throw new HttpError(400, 'Add the transaction ID, a screenshot of the payment, or both.');
        }
        return mutate(store, async (book, notices) => {
          const sub = findSub(book, session.subId);
          if (purpose === 'debt' && sub.debt?.status !== 'active') {
            throw new HttpError(400, 'A debt payment can be claimed only after you sign a debt.');
          }
          const pending = sub.entries.filter((entry) => entry.status === 'pending').length;
          if (pending >= 5) throw new HttpError(400, 'Wait for her to answer the claims already waiting.');
          const entry = pushEntry(sub, stampEntry({
            kind: 'payment',
            amountCents: amount,
            purpose,
            status: 'pending',
            source: 'sub',
            method: 'manual',
            note: text,
            reference: reference || null,
            screenshot: screenshot ? { type: screenshot.type, bytes: screenshot.bytes.length } : null,
          }, now));
          if (screenshot) {
            await mkdir(proofDir, { recursive: true });
            await writeFile(path.join(proofDir, `${entry.id}.${PROOF_TYPES[screenshot.type]}`), screenshot.bytes);
          }
          note(book, {
            audience: 'studio',
            subId: sub.id,
            handle: sub.handle,
            kind: 'claim_pending',
            title: `${sub.handle} claimed a payment`,
            body: `${money(amount)} toward ${purpose} is waiting for you.`,
            href: '/studio',
          }, now, notices);
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/me/self-charge': async () => {
        const session = requireSub(data(), token, now);
        const body = await readBody(req);
        const amount = cents(body.amountCents, LIMITS.minCheckoutCents, LIMITS.maxSelfChargeCents, 'A self-charge');
        const text = noteOf(body.note);
        if (!text) throw new HttpError(400, 'Say what you are adding.');
        return store.update((book) => {
          const sub = findSub(book, session.subId);
          accrueSub(sub, now);
          if (sub.debt?.status !== 'active') throw new HttpError(400, 'You can add to a debt only after you sign it.');
          sub.debt.balanceCents += amount;
          pushEntry(sub, stampEntry({
            kind: 'self_charge',
            amountCents: amount,
            purpose: 'debt',
            source: 'sub',
            note: text,
          }, now));
          return { sub: privateSub(sub, now) };
        });
      },
      'GET /api/me/live': async () => {
        const session = requireSub(data(), token, now);
        return { sub: privateSub(findSub(data(), session.subId), now) };
      },
      'POST /api/me/game/accept': async () => {
        const session = requireSub(data(), token, now);
        const body = await readBody(req);
        const key = gameKeyOf(body.game);
        return mutate(store, (book, notices) => {
          const sub = findSub(book, session.subId);
          const game = sub.games[key];
          if (!game) throw new HttpError(404, `She has not set up the ${GAMES[key].toLowerCase()} for you.`);
          if (game.acceptedVersion === game.version) throw new HttpError(400, 'You already accepted these terms.');
          acceptGame(game, body.version, now);
          pushEntry(sub, stampEntry({
            kind: 'note',
            amountCents: 0,
            source: 'sub',
            note: `${GAMES[key]} terms accepted (version ${game.version})`,
          }, now));
          note(book, {
            audience: 'studio',
            subId: sub.id,
            handle: sub.handle,
            kind: 'game_accepted',
            title: `${sub.handle} accepted ${GAMES[key]} terms`,
            body: `Version ${game.version} is ready to play.`,
            href: `/studio/games/${sub.id}`,
          }, now, notices);
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/me/game/limits': async () => {
        const session = requireSub(data(), token, now);
        const body = await readBody(req);
        const key = gameKeyOf(body.game);
        return store.update((book) => {
          const sub = findSub(book, session.subId);
          const game = sub.games[key];
          if (!game) throw new HttpError(404, `She has not set up the ${GAMES[key].toLowerCase()} for you.`);
          const wasPaused = game.pausedBySub;
          setSubLimits(game, {
            paused: body.paused,
            perPlayCapCents: body.perPlayCapCents,
            dailyCapCents: body.dailyCapCents,
          });
          const limits = effectiveLimits(game);
          const said = wasPaused === game.pausedBySub
            ? `${GAMES[key]} caps set to ${money(limits.perPlayCapCents)} a play and ${money(limits.dailyCapCents)} a day`
            : `${GAMES[key]} ${game.pausedBySub ? 'paused' : 'resumed'}`;
          pushEntry(sub, stampEntry({ kind: 'note', amountCents: 0, source: 'sub', note: said }, now));
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/me/game/play': async () => {
        limit(`play:${ip}`, 60, 60 * 1000);
        const session = requireSub(data(), token, now);
        const body = await readBody(req);
        if (body.game !== 'slot') throw new HttpError(400, 'Only the slot machine is played from your side.');
        const playId = playIdOf(body.playId);
        return store.update((book) => {
          const sub = findSub(book, session.subId);
          const prior = priorPlay(sub, playId, 'slot');
          if (prior) return { play: prior, replayed: true, sub: privateSub(sub, now) };
          accrueSub(sub, now);
          const game = sub.games.slot;
          const odds = game ? slotOdds(game.terms, effectiveLimits(game).perPlayCapCents) : null;
          assertPlayable({ sub, key: 'slot', maxChargeCents: odds?.maxChargeCents ?? 0, now, today: nyDate(now) });
          const reels = drawSlot(game.terms);
          const outcome = odds.outcomes[slotOutcomeIndex(game.terms, reels)];
          const play = recordPlay(sub, {
            id: playId,
            game: 'slot',
            version: game.version,
            reels,
            label: `${outcome.label} (${outcome.multiplierPct / 100}x)`,
            multiplierPct: outcome.multiplierPct,
            amountCents: outcome.chargeCents,
          }, now);
          return { play, replayed: false, sub: privateSub(sub, now) };
        });
      },
      'POST /api/me/atm/pin': async () => {
        limit(`atm-pin-set:${ip}`, 10, 15 * 60 * 1000);
        const session = requireSub(data(), token, now);
        const body = await readBody(req);
        const pin = String(body.pin || '');
        if (!/^\d{4}$/.test(pin)) throw new HttpError(400, 'The card PIN is exactly 4 digits.');
        if (body.notMyBankPin !== true) throw new HttpError(400, 'Confirm this is not a real bank PIN.');
        const secret = await hashSecret(pin);
        return store.update((book) => {
          const sub = findSub(book, session.subId);
          Object.assign(sub.atm, { pinSalt: secret.salt, pinHash: secret.hash, pinFails: 0, lockedUntil: null, card: null });
          pushEntry(sub, stampEntry({ kind: 'note', amountCents: 0, source: 'sub', note: 'ATM card PIN set' }, now));
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/me/atm/load': async () => {
        const session = requireSub(data(), token, now);
        const body = await readBody(req);
        const add = cents(body.addCents, LIMITS.minCheckoutCents, LIMITS.maxAtmCents, 'A reload');
        return store.update((book) => {
          const sub = findSub(book, session.subId);
          const balance = sub.atm.loadedCents - sub.atm.withdrawnCents;
          if (balance + add > LIMITS.maxAtmCents) {
            throw new HttpError(400, `The ATM holds at most ${money(LIMITS.maxAtmCents)} at a time.`);
          }
          sub.atm.loadedCents += add;
          pushEntry(sub, stampEntry({
            kind: 'note',
            amountCents: add,
            source: 'sub',
            note: `ATM loaded. Balance now ${money(balance + add)}`,
          }, now));
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/me/atm/lower': async () => {
        const session = requireSub(data(), token, now);
        const body = await readBody(req);
        return store.update((book) => {
          const sub = findSub(book, session.subId);
          const balance = sub.atm.loadedCents - sub.atm.withdrawnCents;
          const next = cents(body.balanceCents, 0, balance, 'The new balance');
          sub.atm.loadedCents = sub.atm.withdrawnCents + next;
          pushEntry(sub, stampEntry({
            kind: 'note',
            amountCents: next,
            source: 'sub',
            note: `ATM balance lowered to ${money(next)}`,
          }, now));
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/me/atm/freeze': async () => {
        const session = requireSub(data(), token, now);
        const body = await readBody(req);
        return store.update((book) => {
          const sub = findSub(book, session.subId);
          sub.atm.frozen = Boolean(body.frozen);
          if (sub.atm.frozen) sub.atm.card = null;
          pushEntry(sub, stampEntry({
            kind: 'note',
            amountCents: 0,
            source: 'sub',
            note: sub.atm.frozen ? 'ATM frozen' : 'ATM unfrozen',
          }, now));
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/me/hide': async () => {
        const session = requireSub(data(), token, now);
        const body = await readBody(req);
        return store.update((book) => {
          const sub = findSub(book, session.subId);
          sub.hideFromHall = Boolean(body.hideFromHall);
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/me/task-done': async () => {
        const session = requireSub(data(), token, now);
        const body = await readBody(req);
        return mutate(store, (book, notices) => {
          const sub = findSub(book, session.subId);
          const task = sub.tasks.find((item) => item.id === body.taskId);
          if (!task || task.status !== 'open') throw new HttpError(404, 'That task is not open.');
          task.status = 'done_pending';
          task.markedAt = now.toISOString();
          note(book, {
            audience: 'studio',
            subId: sub.id,
            handle: sub.handle,
            kind: 'task_done',
            title: `${sub.handle} marked a task done`,
            body: task.title,
            href: '/studio',
          }, now, notices);
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/checkout': async () => {
        limit(`pay:${ip}`, 12, 60 * 60 * 1000);
        const session = requireSub(data(), token, now);
        const body = await readBody(req);
        const purpose = body.purpose === 'debt' ? 'debt' : 'tribute';
        let amount = body.amountCents;
        let text = noteOf(body.note);
        if (body.tierId) {
          const tier = data().settings.tiers.find((item) => item.id === body.tierId);
          if (!tier) throw new HttpError(404, 'That tier is not on the page.');
          amount = tier.amountCents;
          text = text || tier.name;
        }
        amount = cents(amount, LIMITS.minCheckoutCents, LIMITS.maxCheckoutCents, 'A payment');
        if (purpose === 'debt' && data().subs.find((item) => item.id === session.subId)?.debt?.status !== 'active') {
          throw new HttpError(400, 'Sign the debt before you pay it down here.');
        }
        const open = data().invoices.filter((invoice) => invoice.subId === session.subId && invoice.status === 'pending');
        if (open.length >= 8) throw new HttpError(400, 'Finish or let the open invoices expire first.');
        const id = newId(16);
        let live = null;
        if (ohm.mode() === 'live') {
          try {
            live = await ohm.createInvoice({
              amountCents: amount,
              memo: `Bijoux Debt ${text || purpose}`.slice(0, 80),
            });
          } catch (error) {
            throw new HttpError(503, error instanceof Error ? error.message : 'Lightning checkout is unavailable.');
          }
        }
        const invoice = await store.update((book) => {
          const sub = findSub(book, session.subId);
          if (purpose === 'debt' && sub.debt?.status !== 'active') {
            throw new HttpError(400, 'Sign the debt before you pay it down here.');
          }
          const created = {
            id,
            subId: sub.id,
            amountCents: amount,
            purpose,
            note: text || (purpose === 'debt' ? 'Debt payment' : 'Tribute'),
            status: 'pending',
            mode: live ? 'live' : 'sandbox',
            bolt11: live?.bolt11 || null,
            paymentHashHex: live?.paymentHashHex || null,
            amountSats: live?.amountSats || null,
            createdAt: now.toISOString(),
            expiresAt: live?.expiresAt || new Date(now.getTime() + 3600 * 1000).toISOString(),
          };
          book.invoices.push(created);
          return created;
        });
        return presentInvoice(invoice);
      },
      'POST /api/studio/login': async () => {
        limit(`studio:${ip}`, 5, 15 * 60 * 1000);
        requirePinConfigured();
        const body = await readBody(req);
        const ok = await verifySecret(String(body.pin || ''), pinHash.salt, pinHash.hash);
        if (!ok) throw new HttpError(401, 'That pin does not open the studio.');
        const session = await store.update((book) => {
          const created = { id: newId(32), role: 'studio', expires: new Date(now.getTime() + SESSION_MS).toISOString() };
          book.sessions.push(created);
          return created;
        });
        res.setHeader('Set-Cookie', cookieHeader(session.id, req, base, SESSION_MS / 1000));
        return { role: 'studio' };
      },
      'GET /api/studio': async () => {
        requireStudio(data(), token, now);
        return store.update((book) => {
          for (const sub of book.subs) accrueSub(sub, now);
          const month = nyDate(now).slice(0, 7);
          return {
            checkout: ohm.mode(),
            tiers: book.settings.tiers,
            defaults: { slot: defaultSlotTerms(), atm: defaultAtmTerms(), symbols: SLOT_SYMBOLS },
            month,
            sentThisMonthCents: book.subs.reduce((sum, sub) => sum + monthSent(sub, month), 0),
            subs: book.subs
              .map((sub) => ({ ...privateSub(sub, now), monthCents: monthSent(sub, month) }))
              .sort((a, b) => b.sentCents - a.sentCents),
          };
        });
      },
      'POST /api/studio/debt': async () => {
        requireStudio(data(), token, now);
        const body = await readBody(req);
        const principalCents = cents(body.principalCents, LIMITS.minCheckoutCents, LIMITS.maxPrincipalCents, 'Principal');
        const apr = body.apr;
        if (typeof apr !== 'number' || !Number.isFinite(apr) || apr < 0 || apr > LIMITS.maxApr) {
          throw new HttpError(400, `Interest must be from 0 to ${LIMITS.maxApr}%.`);
        }
        const lateFeeCents = cents(body.lateFeeCents ?? 0, 0, LIMITS.maxLateFeeCents, 'The late fee');
        const minPaymentCents = cents(body.minPaymentCents ?? 0, 0, LIMITS.maxCheckoutCents, 'The minimum');
        const dueDay = body.dueDay;
        if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28) {
          throw new HttpError(400, 'The due day must be from the 1st through the 28th.');
        }
        return mutate(store, (book, notices) => {
          const sub = findSub(book, body.subId);
          if (sub.debt && (sub.debt.status === 'active' || sub.debt.status === 'paused')) {
            throw new HttpError(400, 'Settle the open debt before writing another.');
          }
          sub.debt = {
            status: 'proposed',
            principalCents,
            balanceCents: 0,
            apr: Math.round(apr * 1000) / 1000,
            lateFeeCents,
            minPaymentCents,
            dueDay,
            accruedThrough: null,
            lateFeesApplied: [],
            signedAt: null,
          };
          pushEntry(sub, stampEntry({
            kind: 'proposal',
            amountCents: principalCents,
            purpose: 'debt',
            source: 'domme',
            note: 'Debt proposed. It stays frozen until it is signed.',
          }, now));
          note(book, {
            audience: 'sub',
            subId: sub.id,
            handle: sub.handle,
            kind: 'debt_proposed',
            title: 'A debt is waiting for your signature',
            body: `${money(principalCents)} proposed. It stays frozen until you sign.`,
            href: '/book',
          }, now, notices);
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/studio/charge': async () => studioAmount(data, token, now, req, store, (sub, amount, text, book, notices) => {
        accrueSub(sub, now);
        if (sub.debt?.status !== 'active') throw new HttpError(400, 'Charges land on a signed debt.');
        sub.debt.balanceCents += amount;
        pushEntry(sub, stampEntry({ kind: 'charge', amountCents: amount, purpose: 'debt', source: 'domme', note: text || 'Charge' }, now));
        note(book, {
          audience: 'sub',
          subId: sub.id,
          handle: sub.handle,
          kind: 'charge',
          title: 'A charge was added',
          body: `${money(amount)}${text ? ` · ${text}` : ''}`,
          href: '/book',
        }, now, notices);
      }),
      'POST /api/studio/payment': async () => {
        requireStudio(data(), token, now);
        const body = await readBody(req);
        const amount = cents(body.amountCents, LIMITS.minCheckoutCents, LIMITS.maxCheckoutCents, 'A payment');
        const purpose = body.purpose === 'debt' ? 'debt' : 'tribute';
        const text = noteOf(body.note) || 'Recorded by hand';
        return store.update((book) => {
          const sub = findSub(book, body.subId);
          accrueSub(sub, now);
          if (purpose === 'debt' && sub.debt?.status !== 'active') {
            throw new HttpError(400, 'There is no active debt to pay.');
          }
          const applied = applyConfirmedPayment(sub, amount, purpose);
          pushEntry(sub, stampEntry({
            kind: applied.purpose === 'debt' ? 'payment' : 'tribute',
            amountCents: amount,
            source: 'domme',
            method: 'manual',
            note: text,
            ...applied,
          }, now));
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/studio/claim': async () => {
        requireStudio(data(), token, now);
        const body = await readBody(req);
        if (body.decision !== 'confirm' && body.decision !== 'reject') {
          throw new HttpError(400, 'Confirm or reject the claim.');
        }
        return mutate(store, (book, notices) => {
          const sub = book.subs.find((item) => item.entries.some((entry) => entry.id === body.entryId));
          if (!sub) throw new HttpError(404, 'That claim is not in the book.');
          const entry = sub.entries.find((item) => item.id === body.entryId);
          if (!entry || entry.status !== 'pending') throw new HttpError(400, 'That claim is already settled.');
          accrueSub(sub, now);
          if (body.decision === 'reject') {
            entry.status = 'rejected';
            note(book, {
              audience: 'sub',
              subId: sub.id,
              handle: sub.handle,
              kind: 'claim_decided',
              title: 'Your claim was rejected',
              body: `${money(entry.amountCents)} toward ${entry.purpose} was turned down.`,
              href: '/book',
            }, now, notices);
            return { sub: privateSub(sub, now) };
          }
          const applied = applyConfirmedPayment(sub, entry.amountCents, entry.purpose);
          Object.assign(entry, applied, { status: 'confirmed', kind: applied.purpose === 'debt' ? 'payment' : 'tribute' });
          note(book, {
            audience: 'sub',
            subId: sub.id,
            handle: sub.handle,
            kind: 'claim_decided',
            title: 'Your claim was confirmed',
            body: `${money(entry.amountCents)} toward ${entry.purpose} is in the book.`,
            href: '/book',
          }, now, notices);
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/studio/task': async () => {
        requireStudio(data(), token, now);
        const body = await readBody(req);
        const title = String(body.title || '').trim();
        const detail = String(body.detail || '').trim();
        if (title.length < 2 || title.length > 80) throw new HttpError(400, 'Give the task a short title.');
        if (detail.length > 280) throw new HttpError(400, 'Keep the task detail shorter.');
        if (body.due && !/^\d{4}-\d{2}-\d{2}$/.test(body.due)) throw new HttpError(400, 'Use a due date like 2026-11-30.');
        const penaltyCents = cents(body.penaltyCents ?? 0, 0, LIMITS.maxPenaltyCents, 'The penalty');
        return mutate(store, (book, notices) => {
          const sub = findSub(book, body.subId);
          if (sub.tasks.length >= LIMITS.maxTasks) throw new HttpError(400, 'Clear old tasks first.');
          sub.tasks.push({
            id: newId(8),
            title,
            detail,
            due: body.due || null,
            penaltyCents,
            status: 'open',
            createdAt: now.toISOString(),
          });
          note(book, {
            audience: 'sub',
            subId: sub.id,
            handle: sub.handle,
            kind: 'task_assigned',
            title: 'A new task is waiting',
            body: title,
            href: '/book',
          }, now, notices);
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/studio/verdict': async () => {
        requireStudio(data(), token, now);
        const body = await readBody(req);
        if (body.decision !== 'accept' && body.decision !== 'miss') {
          throw new HttpError(400, 'Accept the task or mark it missed.');
        }
        return mutate(store, (book, notices) => {
          const sub = findSub(book, body.subId);
          const task = sub.tasks.find((item) => item.id === body.taskId);
          if (!task || (task.status !== 'open' && task.status !== 'done_pending')) {
            throw new HttpError(404, 'That task is already decided.');
          }
          accrueSub(sub, now);
          task.status = body.decision === 'accept' ? 'accepted' : 'missed';
          task.decidedAt = now.toISOString();
          if (body.decision === 'miss' && task.penaltyCents > 0) {
            if (sub.debt?.status === 'active') {
              sub.debt.balanceCents += task.penaltyCents;
              pushEntry(sub, stampEntry({
                kind: 'penalty',
                amountCents: task.penaltyCents,
                purpose: 'debt',
                source: 'domme',
                note: `Missed: ${task.title}`,
              }, now));
            } else {
              sub.askCents += task.penaltyCents;
              pushEntry(sub, stampEntry({
                kind: 'penalty',
                amountCents: task.penaltyCents,
                purpose: 'tribute',
                source: 'domme',
                note: `Missed: ${task.title}`,
              }, now));
            }
          }
          note(book, {
            audience: 'sub',
            subId: sub.id,
            handle: sub.handle,
            kind: 'task_verdict',
            title: body.decision === 'accept' ? 'She accepted your task' : 'She marked a task missed',
            body: task.title + (body.decision === 'miss' && task.penaltyCents
              ? ` · penalty ${money(task.penaltyCents)}`
              : ''),
            href: '/book',
          }, now, notices);
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/studio/game': async () => {
        requireStudio(data(), token, now);
        const body = await readBody(req);
        const key = gameKeyOf(body.game);
        const terms = normalizeTerms(key, body.terms);
        return mutate(store, (book, notices) => {
          const sub = findSub(book, body.subId);
          if (sub.games[key]) reviseGame(sub.games[key], terms, now);
          else sub.games[key] = newGame(terms, now);
          pushEntry(sub, stampEntry({
            kind: 'proposal',
            amountCents: 0,
            source: 'domme',
            note: `${GAMES[key]} terms proposed (version ${sub.games[key].version}). Nothing can be played until they are accepted.`,
          }, now));
          note(book, {
            audience: 'sub',
            subId: sub.id,
            handle: sub.handle,
            kind: 'game_terms',
            title: `${GAMES[key]} terms need your acceptance`,
            body: `Version ${sub.games[key].version}. Nothing can be played until you accept.`,
            href: '/games',
          }, now, notices);
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/studio/game/preview': async () => {
        requireStudio(data(), token, now);
        const body = await readBody(req);
        const key = gameKeyOf(body.game);
        const terms = normalizeTerms(key, body.terms);
        return { odds: key === 'slot' ? slotOdds(terms, terms.perPlayCapCents) : atmOdds(terms) };
      },
      'POST /api/studio/standing': async () => {
        requireStudio(data(), token, now);
        const body = await readBody(req);
        return store.update((book) => {
          const sub = findSub(book, body.subId);
          const before = sub.standing;
          const next = normalizeStanding(body, before);
          sub.standing = next;
          const changes = [];
          if (next.hold !== before.hold) changes.push(next.hold ? 'Games are on hold' : 'The hold on games is lifted');
          if (next.lockWhenOverdue !== before.lockWhenOverdue) {
            changes.push(next.lockWhenOverdue ? 'A missed minimum locks games' : 'A missed minimum no longer locks games');
          }
          if (next.minPaidCents !== before.minPaidCents) {
            changes.push(next.minPaidCents ? `Games need ${money(next.minPaidCents)} paid first` : 'No paid minimum for games');
          }
          if (next.maxUnpaidGameCents !== before.maxUnpaidGameCents) {
            changes.push(next.maxUnpaidGameCents ? `Games lock at ${money(next.maxUnpaidGameCents)} in unpaid game charges` : 'No limit on unpaid game charges');
          }
          if (changes.length) {
            pushEntry(sub, stampEntry({ kind: 'note', amountCents: 0, source: 'domme', note: `${changes.join('. ')}.` }, now));
          }
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/studio/atm/pin': async () => {
        requireStudio(data(), token, now);
        const body = await readBody(req);
        const pinTry = String(body.pin || '');
        if (!/^\d{4}$/.test(pinTry)) throw new HttpError(400, 'Type all 4 digits.');
        const result = await store.update(async (book) => {
          const sub = findSub(book, body.subId);
          const atm = sub.atm;
          if (!atm.pinHash) return { error: [400, 'He has not set a card PIN yet.'] };
          if (atm.frozen) return { error: [423, 'He froze the ATM. The card will not go in.'] };
          if (atmLocked(atm, now)) return { error: [423, `The card is locked until ${clockTime(atm.lockedUntil)}.`] };
          const ok = await verifySecret(pinTry, atm.pinSalt, atm.pinHash);
          if (!ok) {
            atm.pinFails = (atm.pinFails || 0) + 1;
            atm.card = null;
            if (atm.pinFails >= LIMITS.atmPinTries) {
              atm.pinFails = 0;
              atm.lockedUntil = new Date(now.getTime() + LIMITS.atmLockMinutes * 60 * 1000).toISOString();
              return { error: [423, `Wrong PIN ${LIMITS.atmPinTries} times. The card is locked for ${LIMITS.atmLockMinutes} minutes.`], sub: privateSub(sub, now) };
            }
            const left = LIMITS.atmPinTries - atm.pinFails;
            return { error: [401, `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left before the card locks.`], sub: privateSub(sub, now) };
          }
          const wrongTries = atm.pinFails || 0;
          atm.pinFails = 0;
          atm.card = {
            token: newId(16),
            wrongTries,
            expires: new Date(now.getTime() + LIMITS.atmCardMinutes * 60 * 1000).toISOString(),
          };
          return { cardToken: atm.card.token, sub: privateSub(sub, now) };
        });
        if (result.error) throw new HttpError(...result.error);
        return result;
      },
      'POST /api/studio/atm/eject': async () => {
        requireStudio(data(), token, now);
        const body = await readBody(req);
        return store.update((book) => {
          const sub = findSub(book, body.subId);
          sub.atm.card = null;
          return { sub: privateSub(sub, now) };
        });
      },
      'POST /api/studio/atm/withdraw': async () => {
        requireStudio(data(), token, now);
        const body = await readBody(req);
        const playId = playIdOf(body.playId);
        const option = body.option;
        if (!ATM_OPTIONS.includes(option)) throw new HttpError(400, 'Pick an amount or a quick option.');
        return store.update((book) => {
          const sub = findSub(book, body.subId);
          const prior = priorPlay(sub, playId, 'atm');
          if (prior) return { play: prior, replayed: true, sub: privateSub(sub, now) };
          const atm = sub.atm;
          if (atm.frozen) throw new HttpError(423, 'He froze the ATM.');
          if (atmLocked(atm, now)) throw new HttpError(423, `The card is locked until ${clockTime(atm.lockedUntil)}.`);
          if (!atm.card || atm.card.token !== body.cardToken || Date.parse(atm.card.expires) <= now.getTime()) {
            throw new HttpError(401, 'Insert the card and type the PIN first.');
          }
          const game = sub.games.atm;
          const terms = game?.terms;
          let worst = 0;
          let label = '';
          if (terms && option === 'amount') {
            worst = cents(body.amountCents, LIMITS.minCheckoutCents, LIMITS.maxGamePlayCents, 'A withdrawal');
            label = 'Withdrawal';
          } else if (terms && option === 'quick') {
            worst = terms.quickCents;
            label = 'Fast cash';
          } else if (terms && option === 'skim') {
            worst = terms.skimMaxCents;
            label = 'Surprise skim';
          } else if (terms) {
            worst = Math.max(...terms.kick.map((item) => item.amountCents));
            label = 'Kicked it for a bonus';
          }
          accrueSub(sub, now);
          assertPlayable({ sub, key: 'atm', maxChargeCents: worst, now, today: nyDate(now) });
          const balance = atm.loadedCents - atm.withdrawnCents;
          if (worst > balance) {
            throw new HttpError(400, option === 'amount' || option === 'quick'
              ? `The ATM only holds ${money(balance)}.`
              : `This could take ${money(worst)}, and the ATM only holds ${money(balance)}. Pick an amount instead.`);
          }
          let amount = worst;
          if (option === 'skim') amount = drawSkim(terms);
          if (option === 'kick') amount = drawKick(terms);
          atm.withdrawnCents += amount;
          const play = recordPlay(sub, {
            id: playId,
            game: 'atm',
            version: game.version,
            option,
            label,
            amountCents: amount,
            wrongTries: atm.card.wrongTries,
            atmBalanceAfterCents: atm.loadedCents - atm.withdrawnCents,
          }, now);
          atm.card.wrongTries = 0;
          return { play, replayed: false, sub: privateSub(sub, now) };
        });
      },
      'POST /api/studio/status': async () => {
        requireStudio(data(), token, now);
        const body = await readBody(req);
        return mutate(store, (book, notices) => {
          const sub = findSub(book, body.subId);
          const debt = sub.debt;
          if (!debt) throw new HttpError(400, 'There is no debt on this name.');
          let label = '';
          if (body.action === 'pause' && debt.status === 'active') {
            accrueSub(sub, now);
            debt.status = 'paused';
            label = 'She paused your debt. Interest is frozen.';
          } else if (body.action === 'resume' && debt.status === 'paused') {
            debt.status = 'active';
            debt.accruedThrough = nyDate(now);
            label = 'She resumed your debt. The clock is running again.';
          } else if (body.action === 'settle' && (debt.status === 'active' || debt.status === 'paused')) {
            if (debt.status === 'active') accrueSub(sub, now);
            debt.status = 'settled';
            pushEntry(sub, stampEntry({ kind: 'settled', amountCents: debt.balanceCents, purpose: 'debt', source: 'domme', note: 'Debt settled. The clock has stopped.' }, now));
            label = 'She settled your debt. The clock has stopped.';
          } else if (body.action === 'forgive' && (debt.status === 'active' || debt.status === 'paused')) {
            if (debt.status === 'active') accrueSub(sub, now);
            const forgiven = debt.balanceCents;
            debt.balanceCents = 0;
            debt.status = 'settled';
            pushEntry(sub, stampEntry({ kind: 'forgive', amountCents: forgiven, purpose: 'debt', source: 'domme', note: 'Balance forgiven. The clock has stopped.' }, now));
            label = 'She forgave the balance. The clock has stopped.';
          } else {
            throw new HttpError(400, 'That cannot be done to this debt.');
          }
          note(book, {
            audience: 'sub',
            subId: sub.id,
            handle: sub.handle,
            kind: 'debt_status',
            title: 'Your debt was updated',
            body: label,
            href: '/book',
          }, now, notices);
          return { sub: privateSub(sub, now) };
        });
      },
      'GET /api/notices': async () => {
        const session = requireActor(data(), token, now);
        const unread = unreadNotices(data(), session).map(publicNotice);
        return { notices: unread, unread: unread.length, push: Boolean(vapidKeys(data())) };
      },
      'POST /api/notices/read': async () => {
        const session = requireActor(data(), token, now);
        const body = await readBody(req);
        const ids = body.all === true ? null : body.ids;
        if (ids != null && !Array.isArray(ids)) throw new HttpError(400, 'Send notice ids, or all: true.');
        await store.update((book) => {
          markNoticesRead(book, session, ids, now);
        });
        return { ok: true, unread: unreadNotices(data(), session).length };
      },
      'GET /api/push/key': async () => {
        requireActor(data(), token, now);
        const keys = await store.update((book) => ensureVapid(book));
        return { publicKey: keys.publicKey };
      },
      'POST /api/push/subscribe': async () => {
        const session = requireActor(data(), token, now);
        const body = await readBody(req);
        try {
          await store.update((book) => {
            ensureVapid(book);
            savePushSubscription(book, session, body.subscription || body, now);
          });
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : 'That push subscription looks wrong.');
        }
        return { ok: true };
      },
      'POST /api/push/unsubscribe': async () => {
        const session = requireActor(data(), token, now);
        const body = await readBody(req);
        const endpoint = String(body.endpoint || body.subscription?.endpoint || '');
        if (!endpoint) throw new HttpError(400, 'Say which push subscription to remove.');
        await store.update((book) => {
          removePushSubscription(book, session, endpoint);
        });
        return { ok: true };
      },
      'POST /api/studio/tiers': async () => {
        requireStudio(data(), token, now);
        const body = await readBody(req);
        if (!Array.isArray(body.tiers) || body.tiers.length > 8) {
          throw new HttpError(400, 'Send up to 8 tiers.');
        }
        const tiers = body.tiers.map((tier) => {
          const name = String(tier.name || '').trim();
          const blurb = String(tier.blurb || '').trim();
          if (name.length < 2 || name.length > 24) throw new HttpError(400, 'Each tier needs a short name.');
          if (blurb.length > 80) throw new HttpError(400, 'Keep each tier line under 80 characters.');
          return {
            id: /^[a-z0-9-]{2,24}$/.test(tier.id || '') ? tier.id : newId(4),
            name,
            blurb,
            amountCents: cents(tier.amountCents, LIMITS.minCheckoutCents, LIMITS.maxCheckoutCents, name || 'A tier'),
          };
        });
        await store.update((book) => {
          book.settings.tiers = tiers;
        });
        return { tiers };
      },
    };

    const dynamic = pathname.match(/^\/api\/checkout\/([a-f0-9]+)$/);
    const simulate = pathname.match(/^\/api\/checkout\/([a-f0-9]+)\/simulate$/);
    const proof = pathname.match(/^\/api\/proof\/([a-f0-9]{16})$/);

    try {
      if (proof && req.method === 'GET') {
        const session = sessionFrom(data(), token, now);
        if (!session) throw new HttpError(401, 'Sign in to see this.');
        const owner = data().subs.find((sub) => sub.entries.some((entry) => entry.id === proof[1]));
        const entry = owner?.entries.find((item) => item.id === proof[1]);
        if (!entry?.screenshot || (session.role !== 'studio' && owner.id !== session.subId)) {
          throw new HttpError(404, 'That screenshot is not in the book.');
        }
        const ext = PROOF_TYPES[entry.screenshot.type];
        let bytes;
        try {
          bytes = await readFile(path.join(proofDir, `${entry.id}.${ext}`));
        } catch {
          throw new HttpError(404, 'That screenshot is not in the book.');
        }
        res.writeHead(200, {
          'Content-Type': entry.screenshot.type,
          'Content-Length': bytes.length,
          'Content-Disposition': `inline; filename="proof-${entry.id}.${ext}"`,
          'Cache-Control': 'private, no-store',
          'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'X-Frame-Options': 'SAMEORIGIN',
        });
        res.end(bytes);
        return;
      }
      if (simulate && req.method === 'POST') {
        const session = requireSub(data(), token, now);
        const invoiceId = simulate[1];
        const invoice = await store.update(async (book) => {
          const current = book.invoices.find((item) => item.id === invoiceId && item.subId === session.subId);
          if (!current) throw new HttpError(404, 'That invoice is not yours.');
          if (current.mode !== 'sandbox') throw new HttpError(400, 'A live Lightning invoice settles on its own.');
          if (current.status === 'pending') await settleInvoice(book, current, now);
          return current;
        });
        send(res, 200, await presentInvoice(invoice));
        return;
      }
      if (dynamic && req.method === 'GET') {
        const session = sessionFrom(data(), token, now);
        if (!session) throw new HttpError(401, 'Sign in to see this invoice.');
        const invoiceId = dynamic[1];
        const existing = data().invoices.find((item) => item.id === invoiceId);
        if (!existing) throw new HttpError(404, 'That invoice is not in the book.');
        if (session.role !== 'studio' && existing.subId !== session.subId) {
          throw new HttpError(404, 'That invoice is not in the book.');
        }
        const invoice = await store.update(async (book) => {
          const current = book.invoices.find((item) => item.id === invoiceId);
          if (current.status === 'pending' && current.mode === 'live') {
            try {
              await settleInvoice(book, current, now);
            } catch {
              return current;
            }
          }
          if (current.status === 'pending' && Date.parse(current.expiresAt) <= now.getTime()) {
            current.status = 'expired';
          }
          return current;
        });
        send(res, 200, await presentInvoice(invoice));
        return;
      }

      const key = `${req.method} ${pathname}`;
      const handler = routes[key];
      if (!handler) {
        if (req.method === 'GET') {
          await serveStatic(pathname, res, base);
          return;
        }
        send(res, 404, { error: 'Not found.' });
        return;
      }
      const payload = await handler();
      send(res, 200, payload);
    } catch (error) {
      const status = error instanceof HttpError || error instanceof GameError || error instanceof ProofError ? error.status : 500;
      if (status === 500) console.error('bijouxdebt', error instanceof Error ? error.message : 'error');
      send(res, status, { error: status === 500 ? 'The book could not do that.' : error.message });
    }
  }

  async function studioAmount(bookData, token, now, req, storeRef, apply) {
    requireStudio(bookData(), token, now);
    const body = await readBody(req);
    const amount = cents(body.amountCents, LIMITS.minCheckoutCents, LIMITS.maxCheckoutCents, 'An amount');
    const text = noteOf(body.note);
    return mutate(storeRef, (book, notices) => {
      const sub = findSub(book, body.subId);
      apply(sub, amount, text, book, notices);
      return { sub: privateSub(sub, now) };
    });
  }

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error('bijouxdebt', error instanceof Error ? error.message : 'error');
      if (!res.headersSent) send(res, 500, { error: 'The book could not do that.' });
    });
  });
  server.ready = ready;
  return server;
}

function requireSub(data, token, now) {
  const session = sessionFrom(data, token, now);
  if (!session || session.role !== 'sub') throw new HttpError(401, 'Open your name first.');
  return session;
}

function requireStudio(data, token, now) {
  const session = sessionFrom(data, token, now);
  if (!session || session.role !== 'studio') throw new HttpError(401, 'The studio is locked.');
  return session;
}

function requireActor(data, token, now) {
  const session = sessionFrom(data, token, now);
  if (!session || (session.role !== 'sub' && session.role !== 'studio')) {
    throw new HttpError(401, 'Sign in first.');
  }
  return session;
}

function clockTime(iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    .format(new Date(iso));
}

async function presentInvoice(invoice) {
  const view = {
    id: invoice.id,
    amountCents: invoice.amountCents,
    purpose: invoice.purpose,
    note: invoice.note,
    status: invoice.status,
    mode: invoice.mode,
    sample: invoice.mode !== 'live',
    bolt11: invoice.mode === 'live' ? invoice.bolt11 : null,
    amountSats: invoice.amountSats,
    expiresAt: invoice.expiresAt,
    qrSvg: null,
  };
  if (view.bolt11) {
    try {
      const svg = await QRCode.toString(view.bolt11, {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#1a0e14', light: '#f6efe8' },
      });
      const trimmed = svg.replace(/^<\?xml[^>]*>/, '').trim();
      if (trimmed.startsWith('<svg')) view.qrSvg = trimmed;
    } catch {
      view.qrSvg = null;
    }
  }
  return view;
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
  });
  res.end(payload);
}

async function serveStatic(pathname, res, base) {
  const relative = pathname === '/' ? '/index.html' : pathname;
  if (!/^\/[a-z0-9._/-]+$/i.test(relative)) {
    send(res, 404, { error: 'Not found.' });
    return;
  }
  if (relative.includes('..')) {
    send(res, 404, { error: 'Not found.' });
    return;
  }
  const file = path.normalize(path.join(PUBLIC_DIR, relative));
  const root = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
  if (!file.startsWith(root)) {
    send(res, 404, { error: 'Not found.' });
    return;
  }
  try {
    if (relative === '/index.html') {
      const html = (await readFile(file, 'utf8')).replaceAll('%%BASE%%', base);
      const body = Buffer.from(html);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'self'; worker-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'SAMEORIGIN',
      });
      res.end(body);
      return;
    }
    const ext = path.extname(file);
    const types = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
    if (!types[ext]) {
      send(res, 404, { error: 'Not found.' });
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': types[ext],
      'Content-Length': body.length,
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch {
    send(res, 404, { error: 'Not found.' });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer();
  server.listen(port, host, () => {
    const shown = basePath() || '/';
    console.log(`Bijoux Debt listening on http://${host}:${port}${shown}`);
  });
}
