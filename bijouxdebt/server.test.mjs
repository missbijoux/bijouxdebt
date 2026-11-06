import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from './server.mjs';

test('both sides share one book, and a sample checkout writes a real line without moving money', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bijouxdebt-'));
  const clock = { current: new Date('2026-01-01T17:00:00.000Z') };
  const server = createServer({
    dataFile: path.join(dir, 'book.json'),
    pin: 'studio-pin-test',
    now: () => clock.current,
    ohm: {
      mode: () => 'sandbox',
      async createInvoice() {
        throw new Error('live invoice was not expected');
      },
      async checkInvoice() {
        throw new Error('live check was not expected');
      },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await server.ready;
  const port = server.address().port;
  const alice = jar();
  const bob = jar();
  const studio = jar();

  try {
    const blocked = await alice.call(port, 'POST', '/api/join', {
      handle: 'alice',
      passphrase: 'alice-pass',
      title: 'devotee',
      adult: false,
    });
    assert.equal(blocked.status, 400);

    const evil = await alice.call(port, 'POST', '/api/join', {
      handle: 'alice',
      passphrase: 'alice-pass',
      title: 'devotee',
      adult: true,
    }, { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);

    const joined = await alice.call(port, 'POST', '/api/join', {
      handle: 'alice',
      passphrase: 'alice-pass',
      title: 'devotee',
      adult: true,
    });
    assert.equal(joined.status, 200);
    assert.equal(joined.json.sub.debt, null);
    assert.equal(JSON.stringify(joined.json).includes('passHash'), false);

    const early = await alice.call(port, 'POST', '/api/me/self-charge', { amountCents: 1000, note: 'too soon' });
    assert.equal(early.status, 400);

    const opened = await studio.call(port, 'POST', '/api/studio/login', { pin: 'nope' });
    assert.equal(opened.status, 401);
    const authed = await studio.call(port, 'POST', '/api/studio/login', { pin: 'studio-pin-test' });
    assert.equal(authed.status, 200);

    const proposed = await studio.call(port, 'POST', '/api/studio/debt', {
      subId: joined.json.sub.id,
      principalCents: 100_000,
      apr: 36.5,
      lateFeeCents: 0,
      minPaymentCents: 0,
      dueDay: 15,
    });
    assert.equal(proposed.status, 200);
    assert.equal(proposed.json.sub.debt.status, 'proposed');
    assert.equal(proposed.json.sub.debt.balanceCents, 0);

    const signed = await alice.call(port, 'POST', '/api/me/sign');
    assert.equal(signed.json.sub.debt.status, 'active');
    assert.equal(signed.json.sub.debt.balanceCents, 100_000);

    clock.current = new Date('2026-01-03T17:00:00.000Z');
    const accrued = await alice.call(port, 'GET', '/api/session');
    assert.equal(accrued.json.sub.debt.balanceCents, 100_200);

    const invoice = await alice.call(port, 'POST', '/api/checkout', {
      amountCents: 5_000,
      purpose: 'debt',
      note: 'first stone',
    });
    assert.equal(invoice.json.sample, true);
    assert.equal(invoice.json.bolt11, null);

    const stolen = await bob.call(port, 'POST', `/api/checkout/${invoice.json.id}/simulate`);
    assert.equal(stolen.status, 401);
    const bobJoined = await bob.call(port, 'POST', '/api/join', {
      handle: 'bob',
      passphrase: 'bob-passphrase',
      title: 'sub',
      adult: true,
    });
    assert.equal(bobJoined.status, 200);
    const stillStolen = await bob.call(port, 'POST', `/api/checkout/${invoice.json.id}/simulate`);
    assert.equal(stillStolen.status, 404);

    const paid = await alice.call(port, 'POST', `/api/checkout/${invoice.json.id}/simulate`);
    assert.equal(paid.json.status, 'paid');
    const afterPay = await alice.call(port, 'GET', '/api/session');
    assert.equal(afterPay.json.sub.debt.balanceCents, 95_200);
    assert.equal(afterPay.json.sub.sentCents, 5_000);

    const again = await alice.call(port, 'POST', `/api/checkout/${invoice.json.id}/simulate`);
    assert.equal(again.json.status, 'paid');
    const notDoubled = await alice.call(port, 'GET', '/api/session');
    assert.equal(notDoubled.json.sub.debt.balanceCents, 95_200);

    const claim = await alice.call(port, 'POST', '/api/me/claim', {
      amountCents: 2_000,
      purpose: 'debt',
      note: 'sent on Cash App',
    });
    assert.equal(claim.json.sub.entries.at(-1).status, 'pending');
    const confirmed = await studio.call(port, 'POST', '/api/studio/claim', {
      entryId: claim.json.sub.entries.at(-1).id,
      decision: 'confirm',
    });
    assert.equal(confirmed.json.sub.debt.balanceCents, 93_200);

    const task = await studio.call(port, 'POST', '/api/studio/task', {
      subId: joined.json.sub.id,
      title: 'Morning line',
      detail: 'One sentence before noon.',
      due: '2026-01-04',
      penaltyCents: 1_500,
    });
    const taskId = task.json.sub.tasks[0].id;
    await alice.call(port, 'POST', '/api/me/task-done', { taskId });
    const missed = await studio.call(port, 'POST', '/api/studio/verdict', {
      subId: joined.json.sub.id,
      taskId,
      decision: 'miss',
    });
    assert.equal(missed.json.sub.debt.balanceCents, 94_700);

    await alice.call(port, 'POST', '/api/me/purse', { capCents: 5_000 });
    const draw = await studio.call(port, 'POST', '/api/studio/purse-draw', {
      subId: joined.json.sub.id,
      amountCents: 2_000,
      note: 'A draw against the purse',
    });
    assert.equal(draw.json.sub.debt.balanceCents, 96_700);
    const over = await studio.call(port, 'POST', '/api/studio/purse-draw', {
      subId: joined.json.sub.id,
      amountCents: 4_000,
      note: 'too much',
    });
    assert.equal(over.status, 400);

    const pub = await alice.call(port, 'GET', '/api/public');
    assert.equal(pub.json.checkout, 'sandbox');
    assert.equal(pub.json.hall[0].handle, 'alice');
    assert.equal(pub.json.hall[0].sentCents, 7_000);
    assert.equal(JSON.stringify(pub.json).includes('passHash'), false);
    assert.equal(JSON.stringify(pub.json).includes('balanceCents'), false);

    const page = await fetch(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Bijoux Debt/);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);

    const escaped = await fetch(`http://127.0.0.1:${port}/%2e%2e/%2e%2e/package.json`);
    assert.equal(escaped.status, 404);
    const leaked = await escaped.text();
    assert.equal(leaked.includes('qrcode'), false);
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close');
    await rm(dir, { recursive: true, force: true });
  }
});

function jar() {
  let cookie = '';
  return {
    async call(port, method, urlPath, body, headers = {}) {
      const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      if (cookies[0]) cookie = cookies[0].split(';')[0];
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    },
  };
}
