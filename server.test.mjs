import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from './server.mjs';

async function withApp(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ohmtracker-'));
  const app = createServer({
    dataFile: path.join(dir, 'book.json'),
    pin: 'manager-pin-1234',
    ohm: {
      mode: () => 'sandbox',
      createInvoice: async () => {
        throw new Error('live invoices unused in tests');
      },
      checkInvoice: async () => ({ status: 'pending' }),
    },
  });
  await app.listen(0, '127.0.0.1');
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await run({ app, base, jar: { cookie: '' } });
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function req(base, jar, method, urlPath, body) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(jar.cookie ? { Cookie: jar.cookie } : {}),
      Origin: base,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie?.() || [];
  for (const line of set) {
    const part = line.split(';')[0];
    if (part.startsWith('ot_session=')) jar.cookie = part;
  }
  const data = await res.json();
  return { status: res.status, data };
}

test('public surface names Ohm Tracker and shows disclaimer', async () => {
  await withApp(async ({ base, jar }) => {
    const { status, data } = await req(base, jar, 'GET', '/api/public');
    assert.equal(status, 200);
    assert.equal(data.product, 'Ohm Tracker');
    assert.match(data.disclaimer, /not calculate payroll/i);
    assert.match(data.disclaimer, /merchant of record/i);
  });
});

test('manager can add dancer, customer tops up sample, tips with house cut, payout clears unpaid', async () => {
  await withApp(async ({ base, jar }) => {
    let res = await req(base, jar, 'POST', '/api/manager/login', { pin: 'manager-pin-1234' });
    assert.equal(res.status, 200);
    assert.equal(res.data.role, 'manager');

    res = await req(base, jar, 'POST', '/api/manager/settings', {
      clubName: 'Copper Room',
      houseCutPercent: 20,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.houseCutPercent, 20);

    res = await req(base, jar, 'POST', '/api/manager/dancers', {
      handle: 'luxe',
      displayName: 'Luxe',
      passphrase: 'dancer-pass',
    });
    assert.equal(res.status, 200);
    const tipCode = res.data.dancer.tipCode;
    assert.ok(tipCode);

    const customerJar = { cookie: '' };
    res = await req(base, customerJar, 'POST', '/api/customer/join', {
      handle: 'patron',
      passphrase: 'customer-pass',
      adult: true,
    });
    assert.equal(res.status, 200);

    const pub = await req(base, customerJar, 'GET', '/api/public');
    res = await req(base, customerJar, 'POST', '/api/checkout/topup', {
      amountCents: 10000,
      code: pub.data.topUpCode,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.sample, true);
    const invoiceId = res.data.invoice.id;

    res = await req(base, customerJar, 'POST', '/api/checkout/settle', {
      invoiceId,
      samplePay: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.invoice.status, 'paid');
    assert.equal(res.data.customer.creditCents, 10000);

    res = await req(base, customerJar, 'POST', '/api/tip', {
      tipCode,
      amountCents: 2500,
      note: 'Table tip',
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.split.houseCents, 500);
    assert.equal(res.data.split.dancerCents, 2000);
    assert.equal(res.data.customer.creditCents, 7500);

    res = await req(base, jar, 'GET', '/api/session');
    assert.equal(res.data.summary.tipCents, 2500);
    assert.equal(res.data.summary.houseCents, 500);
    const dancer = res.data.dancers.find((item) => item.handle === 'luxe');
    assert.equal(dancer.unpaidCents, 2000);

    res = await req(base, jar, 'POST', '/api/manager/payout', {
      dancerId: dancer.id,
      amountCents: 2000,
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.dancer.unpaidCents, 0);
  });
});

test('tip fails without enough credits', async () => {
  await withApp(async ({ base, jar }) => {
    await req(base, jar, 'POST', '/api/manager/login', { pin: 'manager-pin-1234' });
    const dancer = await req(base, jar, 'POST', '/api/manager/dancers', {
      handle: 'nova',
      displayName: 'Nova',
      passphrase: 'dancer-pass',
    });
    const customerJar = { cookie: '' };
    await req(base, customerJar, 'POST', '/api/customer/join', {
      handle: 'broke',
      passphrase: 'customer-pass',
      adult: true,
    });
    const res = await req(base, customerJar, 'POST', '/api/tip', {
      tipCode: dancer.data.dancer.tipCode,
      amountCents: 500,
    });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /Not enough credits/);
  });
});
