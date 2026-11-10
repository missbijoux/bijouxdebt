/**
 * Lightning checkout against the same LND node Pantheon calls Ohm.
 * With no macaroon configured, checkout stays in sample mode and moves no money.
 */

import https from 'node:https';
import { Buffer } from 'node:buffer';

const RATE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';

export const LND_CONNECT_TIMEOUT_MS = 10_000;
const CHECKOUT_BUDGET_MS = 9_000;
const RATE_TIMEOUT_MS = 5_000;
const MIN_CONNECT_MS = 2_000;

class LndTimeout extends Error {}

let rateCache = { at: 0, usd: 0 };

export function satsForCents(amountCents, btcUsd) {
  if (!(btcUsd >= 1000 && btcUsd <= 10_000_000)) {
    throw new Error('Bitcoin price looks wrong, so no invoice was created.');
  }
  const sats = Math.ceil(amountCents / 100 / (btcUsd / 1e8));
  if (sats < 1 || sats > 50_000_000) {
    throw new Error('That amount cannot be invoiced right now.');
  }
  return sats;
}

export function mapLndInvoice(invoice, now = Date.now()) {
  const settled = invoice.settled === true;
  const creation = Number.parseInt(invoice.creation_date, 10) * 1000;
  const expiry = Number.parseInt(invoice.expiry, 10) * 1000;
  const timedOut = Number.isFinite(creation) && Number.isFinite(expiry) && now > creation + expiry;
  let status = 'pending';
  if (settled) status = 'paid';
  else if (invoice.state === 'CANCELED') status = 'cancelled';
  else if (timedOut) status = 'expired';
  return {
    status,
    settled,
    amountPaidSats: Number.parseInt(invoice.amt_paid_sat || '0', 10) || 0,
  };
}

function lndTarget() {
  const host = process.env.LND_HOST || '';
  const port = process.env.LND_REST_PORT || '8080';
  if (!/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error('LND_HOST must be a hostname or IP.');
  }
  if (!/^\d{2,5}$/.test(port)) {
    throw new Error('LND_REST_PORT must be a port number.');
  }
  return { host, port };
}

function lndAgent() {
  const cert = process.env.LND_TLS_CERT_BASE64;
  const insecure = process.env.LND_TLS_INSECURE === 'true';
  if (!cert && !insecure) {
    throw new Error(
      'Set LND_TLS_CERT_BASE64 from the node certificate, or LND_TLS_INSECURE=true to skip verification.',
    );
  }
  return new https.Agent({
    ca: cert ? Buffer.from(cert, 'base64') : undefined,
    rejectUnauthorized: !insecure,
  });
}

/**
 * req.setTimeout only starts once a socket is connected, so a node that drops
 * packets would hang until the operating system gives up. The connect timer
 * starts with the request and stops once TLS is up or a response arrives.
 */
export function lndRequest(path, method, body, { connectTimeoutMs = LND_CONNECT_TIMEOUT_MS } = {}) {
  const { host, port } = lndTarget();
  const macaroon = process.env.LND_MACAROON_HEX || '';
  if (!macaroon) throw new Error('Lightning checkout is not configured.');
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    let connectTimer = null;
    const req = https.request(
      {
        host,
        port,
        path,
        method,
        agent: lndAgent(),
        headers: {
          'Grpc-Metadata-macaroon': macaroon,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        clearTimeout(connectTimer);
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            reject(new Error(`Lightning node responded ${res.statusCode}.`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('Lightning node returned an unreadable response.'));
          }
        });
      },
    );
    const seconds = Math.ceil(connectTimeoutMs / 1000);
    connectTimer = setTimeout(() => {
      req.destroy(new LndTimeout(`Lightning node did not answer within ${seconds} second${seconds === 1 ? '' : 's'}.`));
    }, connectTimeoutMs);
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => clearTimeout(connectTimer));
    });
    req.setTimeout(15000, () => {
      req.destroy(new LndTimeout('Lightning node timed out.'));
    });
    req.on('error', (error) => {
      clearTimeout(connectTimer);
      reject(new Error(error instanceof LndTimeout ? error.message : 'Lightning node could not be reached.'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function bitcoinUsd() {
  if (Date.now() - rateCache.at < 60_000 && rateCache.usd) return rateCache.usd;
  let response;
  try {
    response = await fetch(RATE_URL, { signal: AbortSignal.timeout(RATE_TIMEOUT_MS) });
  } catch {
    throw new Error('Could not price Bitcoin, so no invoice was created.');
  }
  if (!response.ok) throw new Error('Could not price Bitcoin, so no invoice was created.');
  const body = await response.json();
  const usd = body?.bitcoin?.usd;
  if (typeof usd !== 'number') throw new Error('Could not price Bitcoin, so no invoice was created.');
  rateCache = { at: Date.now(), usd };
  return usd;
}

export function createOhm() {
  return {
    mode() {
      return process.env.LND_MACAROON_HEX ? 'live' : 'sandbox';
    },
    async createInvoice({ amountCents, memo }) {
      const started = Date.now();
      const btcUsd = await bitcoinUsd();
      const amountSats = satsForCents(amountCents, btcUsd);
      const includeRouteHints = process.env.LND_INVOICE_INCLUDE_ROUTE_HINTS !== 'false';
      const body = {
        value: String(amountSats),
        memo: String(memo || 'Ohm Tracker').slice(0, 80),
        expiry: '3600',
      };
      if (includeRouteHints) body.private = true;
      const left = CHECKOUT_BUDGET_MS - (Date.now() - started);
      const created = await lndRequest('/v1/invoices', 'POST', body, { connectTimeoutMs: Math.max(left, MIN_CONNECT_MS) });
      const paymentHashHex = Buffer.from(created.r_hash, 'base64').toString('hex');
      const bolt11 = String(created.payment_request || '').trim().replace(/^lightning:/i, '');
      if (!/^ln[a-z0-9]+$/i.test(bolt11) || !/^[a-f0-9]+$/i.test(paymentHashHex)) {
        throw new Error('Lightning node returned an unusable invoice.');
      }
      return {
        mode: 'live',
        bolt11,
        paymentHashHex,
        amountSats,
        btcUsd,
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      };
    },
    async checkInvoice(paymentHashHex) {
      if (!/^[a-f0-9]+$/i.test(paymentHashHex)) {
        throw new Error('Unknown invoice.');
      }
      const invoice = await lndRequest(`/v1/invoice/${paymentHashHex}`, 'GET');
      return mapLndInvoice(invoice);
    },
  };
}
