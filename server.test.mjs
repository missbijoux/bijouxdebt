import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

async function boot(seed) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bijouxdebt-'));
  const dataFile = path.join(dir, 'book.json');
  if (seed) await writeFile(dataFile, JSON.stringify(seed));
  const clock = { current: new Date('2026-03-02T17:00:00.000Z') };
  const server = createServer({
    dataFile,
    pin: 'studio-pin-test',
    now: () => clock.current,
    ohm: { mode: () => 'sandbox' },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await server.ready;
  return {
    port: server.address().port,
    clock,
    later(ms) {
      clock.current = new Date(clock.current.getTime() + ms);
    },
    async close() {
      server.closeAllConnections?.();
      server.close();
      await once(server, 'close');
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function playId() {
  return randomBytes(16).toString('hex');
}

const SLOT = {
  symbols: [{ id: 'gem', weight: 1 }, { id: 'ring', weight: 1 }],
  stakeCents: 1_000,
  payouts: [
    { match: 'three', symbol: 'gem', multiplierPct: 500 },
    { match: 'three', symbol: null, multiplierPct: 300 },
    { match: 'two', symbol: null, multiplierPct: 200 },
    { match: 'other', symbol: null, multiplierPct: 100 },
  ],
  perPlayCapCents: 3_000,
  dailyCapCents: 9_000,
  cooldownSeconds: 30,
};

const ATM = {
  quickCents: 1_000,
  skimMinCents: 500,
  skimMaxCents: 1_500,
  kick: [{ amountCents: 500, weight: 1 }, { amountCents: 2_500, weight: 3 }],
  perPlayCapCents: 3_000,
  dailyCapCents: 10_000,
  cooldownSeconds: 10,
};

async function signedPair(t) {
  const alice = jar();
  const bob = jar();
  const studio = jar();
  const joined = await alice.call(t.port, 'POST', '/api/join', { handle: 'alice', passphrase: 'alice-pass', title: 'atm', adult: true });
  await bob.call(t.port, 'POST', '/api/join', { handle: 'bob', passphrase: 'bob-passphrase', title: 'sub', adult: true });
  await studio.call(t.port, 'POST', '/api/studio/login', { pin: 'studio-pin-test' });
  return { alice, bob, studio, aliceId: joined.json.sub.id };
}

async function signDebt(t, studio, alice, subId) {
  await studio.call(t.port, 'POST', '/api/studio/debt', { subId, principalCents: 10_000, apr: 0, dueDay: 15 });
  const signed = await alice.call(t.port, 'POST', '/api/me/sign');
  assert.equal(signed.json.sub.debt.balanceCents, 10_000);
}

test('the slot machine needs consent and a signed debt, never draws twice, and only ever adds', async () => {
  const t = await boot();
  try {
    const { alice, bob, studio, aliceId } = await signedPair(t);
    const port = t.port;

    for (const [method, url] of [
      ['POST', '/api/studio/game'],
      ['POST', '/api/studio/game/preview'],
      ['POST', '/api/studio/atm/pin'],
      ['POST', '/api/studio/atm/withdraw'],
      ['POST', '/api/studio/atm/eject'],
    ]) {
      const blocked = await alice.call(port, method, url, { subId: aliceId, game: 'slot', terms: SLOT, pin: '1234' });
      assert.equal(blocked.status, 401, url);
    }

    const zero = await studio.call(port, 'POST', '/api/studio/game', {
      subId: aliceId,
      game: 'slot',
      terms: { ...SLOT, payouts: [{ match: 'other', multiplierPct: 0 }] },
    });
    assert.equal(zero.status, 400);

    const preview = await studio.call(port, 'POST', '/api/studio/game/preview', { game: 'slot', terms: SLOT });
    assert.deepEqual(preview.json.odds.outcomes.map((item) => item.percent), [12.5, 12.5, 75, 0]);

    const setUp = await studio.call(port, 'POST', '/api/studio/game', { subId: aliceId, game: 'slot', terms: SLOT });
    assert.equal(setUp.status, 200);
    const view = setUp.json.sub.games.slot;
    assert.equal(view.status, 'proposed');
    assert.deepEqual(view.odds.outcomes.map((item) => item.chargeCents), [3_000, 3_000, 2_000, 1_000]);
    assert.equal(view.odds.average.cents, 2_250);
    assert.match(view.odds.rigged, /Rigged in her favor/);

    const unsigned = await alice.call(port, 'POST', '/api/me/game/play', { game: 'slot', playId: playId() });
    assert.equal(unsigned.status, 409);
    const accepted = await alice.call(port, 'POST', '/api/me/game/accept', { game: 'slot', version: 1 });
    assert.equal(accepted.json.sub.games.slot.status, 'ready');

    const noDebt = await alice.call(port, 'POST', '/api/me/game/play', { game: 'slot', playId: playId() });
    assert.equal(noDebt.status, 400);
    assert.match(noDebt.json.error, /active signed debt/);
    await signDebt(t, studio, alice, aliceId);

    const bobSees = await bob.call(port, 'GET', '/api/me/live');
    assert.equal(bobSees.json.sub.games.slot, null);
    assert.equal(JSON.stringify(bobSees.json).includes('alice'), false);
    assert.equal((await bob.call(port, 'POST', '/api/me/game/accept', { game: 'slot', version: 1 })).status, 404);

    const id = playId();
    const first = await alice.call(port, 'POST', '/api/me/game/play', { game: 'slot', playId: id });
    assert.equal(first.status, 200);
    assert.equal(first.json.replayed, false);
    assert.equal(first.json.play.reels.length, 3);
    assert.equal(first.json.play.balanceBeforeCents, 10_000);
    assert.equal(first.json.sub.debt.balanceCents, 10_000 + first.json.play.amountCents);
    assert.ok(first.json.play.amountCents >= 2_000);
    const line = first.json.sub.entries.at(-1);
    assert.equal(line.kind, 'game');
    assert.equal(line.game, 'slot');
    assert.equal(line.amountCents, first.json.play.amountCents);
    assert.match(line.note, /^Slot machine: /);

    for (let i = 0; i < 3; i += 1) {
      const retry = await alice.call(port, 'POST', '/api/me/game/play', { game: 'slot', playId: id });
      assert.equal(retry.json.replayed, true);
      assert.deepEqual(retry.json.play, first.json.play);
      assert.equal(retry.json.sub.debt.balanceCents, first.json.sub.debt.balanceCents);
    }
    const doubled = await Promise.all([1, 2].map(() => alice.call(port, 'POST', '/api/me/game/play', { game: 'slot', playId: id })));
    assert.ok(doubled.every((res) => res.json.play.entryId === first.json.play.entryId));

    const stolen = await bob.call(port, 'POST', '/api/me/game/play', { game: 'slot', playId: id });
    assert.equal(stolen.status, 404);
    assert.equal(stolen.json.play, undefined);

    const cooling = await alice.call(port, 'POST', '/api/me/game/play', { game: 'slot', playId: playId() });
    assert.equal(cooling.status, 429);

    let balance = first.json.sub.debt.balanceCents;
    let spent = first.json.play.amountCents;
    const studioView = await studio.call(port, 'GET', '/api/studio');
    assert.equal(studioView.json.subs.find((sub) => sub.id === aliceId).entries.at(-1).kind, 'game');

    let refusedByDailyCap = false;
    for (let i = 0; i < 6; i += 1) {
      t.later(30_000);
      const res = await alice.call(port, 'POST', '/api/me/game/play', { game: 'slot', playId: playId() });
      if (res.status === 400) {
        assert.match(res.json.error, /Today's cap leaves/);
        assert.ok(spent + 3_000 > 9_000);
        refusedByDailyCap = true;
        break;
      }
      assert.equal(res.status, 200);
      assert.ok(res.json.sub.debt.balanceCents > balance);
      balance = res.json.sub.debt.balanceCents;
      spent += res.json.play.amountCents;
      assert.ok(spent <= 9_000);
    }
    assert.ok(refusedByDailyCap);

    t.later(24 * 60 * 60 * 1000);
    const raise = await alice.call(port, 'POST', '/api/me/game/limits', { game: 'slot', perPlayCapCents: 3_001 });
    assert.equal(raise.status, 400);
    const lowered = await alice.call(port, 'POST', '/api/me/game/limits', { game: 'slot', perPlayCapCents: 1_000 });
    assert.deepEqual(lowered.json.sub.games.slot.odds.outcomes.map((item) => item.chargeCents), [1_000, 1_000, 1_000, 1_000]);
    const capped = await alice.call(port, 'POST', '/api/me/game/play', { game: 'slot', playId: playId() });
    assert.equal(capped.json.play.amountCents, 1_000);

    t.later(30_000);
    await alice.call(port, 'POST', '/api/me/game/limits', { game: 'slot', paused: true });
    assert.equal((await alice.call(port, 'POST', '/api/me/game/play', { game: 'slot', playId: playId() })).status, 400);
    await alice.call(port, 'POST', '/api/me/game/limits', { game: 'slot', paused: false });

    const edited = await studio.call(port, 'POST', '/api/studio/game', { subId: aliceId, game: 'slot', terms: { ...SLOT, stakeCents: 1_500 } });
    assert.equal(edited.json.sub.games.slot.status, 'proposed');
    assert.equal(edited.json.sub.games.slot.version, 2);
    assert.equal((await alice.call(port, 'POST', '/api/me/game/play', { game: 'slot', playId: playId() })).status, 409);
    assert.equal((await alice.call(port, 'POST', '/api/me/game/accept', { game: 'slot', version: 1 })).status, 409);
    const reaccepted = await alice.call(port, 'POST', '/api/me/game/accept', { game: 'slot', version: 2 });
    assert.equal(reaccepted.json.sub.games.slot.status, 'ready');
    assert.equal(reaccepted.json.sub.games.slot.subLimits.perPlayCapCents, 1_000);
    const afterEdit = await alice.call(port, 'POST', '/api/me/game/play', { game: 'slot', playId: playId() });
    assert.equal(afterEdit.status, 200);

    const games = afterEdit.json.sub.entries.filter((entry) => entry.kind === 'game');
    assert.ok(games.every((entry) => entry.amountCents > 0 && entry.purpose === 'debt'));
    const plays = afterEdit.json.sub.games.slot.plays;
    assert.ok(plays.every((play) => play.balanceAfterCents === play.balanceBeforeCents + play.amountCents && play.amountCents > 0));

    await studio.call(port, 'POST', '/api/studio/status', { subId: aliceId, action: 'settle' });
    t.later(30_000);
    const settled = await alice.call(port, 'POST', '/api/me/game/play', { game: 'slot', playId: playId() });
    assert.equal(settled.status, 400);
  } finally {
    await t.close();
  }
});

test('the human ATM locks after three wrong PINs, never passes the loaded balance, and hides the PIN', async () => {
  const t = await boot();
  try {
    const { alice, bob, studio, aliceId } = await signedPair(t);
    const port = t.port;
    await signDebt(t, studio, alice, aliceId);

    const noPin = await studio.call(port, 'POST', '/api/studio/atm/pin', { subId: aliceId, pin: '1234' });
    assert.equal(noPin.status, 400);
    const unconfirmed = await alice.call(port, 'POST', '/api/me/atm/pin', { pin: '4321' });
    assert.equal(unconfirmed.status, 400);
    assert.equal((await alice.call(port, 'POST', '/api/me/atm/pin', { pin: '43210', notMyBankPin: true })).status, 400);
    const pinned = await alice.call(port, 'POST', '/api/me/atm/pin', { pin: '4321', notMyBankPin: true });
    assert.equal(pinned.json.sub.atm.pinSet, true);
    const loaded = await alice.call(port, 'POST', '/api/me/atm/load', { addCents: 5_000 });
    assert.equal(loaded.json.sub.atm.balanceCents, 5_000);

    const noCard = await studio.call(port, 'POST', '/api/studio/atm/withdraw', { subId: aliceId, playId: playId(), option: 'quick' });
    assert.equal(noCard.status, 401);

    assert.equal((await studio.call(port, 'POST', '/api/studio/atm/pin', { subId: aliceId, pin: '0000' })).status, 401);
    const second = await studio.call(port, 'POST', '/api/studio/atm/pin', { subId: aliceId, pin: '1111' });
    assert.match(second.json.error, /1 try left/);
    const third = await studio.call(port, 'POST', '/api/studio/atm/pin', { subId: aliceId, pin: '2222' });
    assert.equal(third.status, 423);
    const whileLocked = await studio.call(port, 'POST', '/api/studio/atm/pin', { subId: aliceId, pin: '4321' });
    assert.equal(whileLocked.status, 423);
    t.later(14 * 60 * 1000);
    assert.equal((await studio.call(port, 'POST', '/api/studio/atm/pin', { subId: aliceId, pin: '4321' })).status, 423);
    t.later(60 * 1000 + 1);

    await studio.call(port, 'POST', '/api/studio/atm/pin', { subId: aliceId, pin: '9999' });
    const opened = await studio.call(port, 'POST', '/api/studio/atm/pin', { subId: aliceId, pin: '4321' });
    assert.equal(opened.status, 200);
    const card = opened.json.cardToken;
    assert.match(card, /^[a-f0-9]{32}$/);

    const noTerms = await studio.call(port, 'POST', '/api/studio/atm/withdraw', { subId: aliceId, cardToken: card, playId: playId(), option: 'quick' });
    assert.equal(noTerms.status, 404);
    await studio.call(port, 'POST', '/api/studio/game', { subId: aliceId, game: 'atm', terms: ATM });
    const unaccepted = await studio.call(port, 'POST', '/api/studio/atm/withdraw', { subId: aliceId, cardToken: card, playId: playId(), option: 'quick' });
    assert.equal(unaccepted.status, 409);
    await alice.call(port, 'POST', '/api/me/game/accept', { game: 'atm', version: 1 });

    const negative = await studio.call(port, 'POST', '/api/studio/atm/withdraw', { subId: aliceId, cardToken: card, playId: playId(), option: 'amount', amountCents: -500 });
    assert.equal(negative.status, 400);
    const overCap = await studio.call(port, 'POST', '/api/studio/atm/withdraw', { subId: aliceId, cardToken: card, playId: playId(), option: 'amount', amountCents: 3_500 });
    assert.equal(overCap.status, 400);
    const wrongCard = await studio.call(port, 'POST', '/api/studio/atm/withdraw', { subId: aliceId, cardToken: 'f'.repeat(32), playId: playId(), option: 'quick' });
    assert.equal(wrongCard.status, 401);

    const id = playId();
    const take = await studio.call(port, 'POST', '/api/studio/atm/withdraw', { subId: aliceId, cardToken: card, playId: id, option: 'amount', amountCents: 3_000 });
    assert.equal(take.status, 200);
    assert.equal(take.json.play.wrongTries, 1);
    assert.equal(take.json.play.atmBalanceAfterCents, 2_000);
    assert.equal(take.json.sub.atm.balanceCents, 2_000);
    assert.equal(take.json.sub.debt.balanceCents, 13_000);
    assert.equal(take.json.sub.entries.at(-1).kind, 'game');
    const again = await studio.call(port, 'POST', '/api/studio/atm/withdraw', { subId: aliceId, cardToken: card, playId: id, option: 'amount', amountCents: 3_000 });
    assert.equal(again.json.replayed, true);
    assert.equal(again.json.sub.atm.balanceCents, 2_000);
    assert.equal(again.json.sub.debt.balanceCents, 13_000);

    t.later(10_000);
    const kickTooBig = await studio.call(port, 'POST', '/api/studio/atm/withdraw', { subId: aliceId, cardToken: card, playId: playId(), option: 'kick' });
    assert.equal(kickTooBig.status, 400);
    assert.match(kickTooBig.json.error, /only holds \$20\.00/);
    const skim = await studio.call(port, 'POST', '/api/studio/atm/withdraw', { subId: aliceId, cardToken: card, playId: playId(), option: 'skim' });
    assert.equal(skim.status, 200);
    assert.ok(skim.json.play.amountCents >= 500 && skim.json.play.amountCents <= 1_500);
    const left = 2_000 - skim.json.play.amountCents;
    assert.equal(skim.json.sub.atm.balanceCents, left);

    const below = await alice.call(port, 'POST', '/api/me/atm/lower', { balanceCents: left + 1 });
    assert.equal(below.status, 400);
    const lowered = await alice.call(port, 'POST', '/api/me/atm/lower', { balanceCents: 0 });
    assert.equal(lowered.json.sub.atm.balanceCents, 0);
    assert.equal(lowered.json.sub.atm.withdrawnCents, 3_000 + skim.json.play.amountCents);
    t.later(10_000);
    const empty = await studio.call(port, 'POST', '/api/studio/atm/withdraw', { subId: aliceId, cardToken: card, playId: playId(), option: 'amount', amountCents: 100 });
    assert.equal(empty.status, 400);

    await alice.call(port, 'POST', '/api/me/atm/load', { addCents: 2_000 });
    const frozen = await alice.call(port, 'POST', '/api/me/atm/freeze', { frozen: true });
    assert.equal(frozen.json.sub.atm.frozen, true);
    const cold = await studio.call(port, 'POST', '/api/studio/atm/withdraw', { subId: aliceId, cardToken: card, playId: playId(), option: 'quick' });
    assert.equal(cold.status, 423);
    await alice.call(port, 'POST', '/api/me/atm/freeze', { frozen: false });
    const stale = await studio.call(port, 'POST', '/api/studio/atm/withdraw', { subId: aliceId, cardToken: card, playId: playId(), option: 'quick' });
    assert.equal(stale.status, 401);

    const bobView = await bob.call(port, 'GET', '/api/me/live');
    assert.equal(bobView.json.sub.atm.balanceCents, 0);
    assert.equal(bobView.json.sub.games.atm, null);

    const live = await alice.call(port, 'GET', '/api/me/live');
    const studioView = await studio.call(port, 'GET', '/api/studio');
    for (const payload of [live.json, studioView.json, pinned.json, take.json]) {
      const text = JSON.stringify(payload);
      assert.equal(text.includes('pinHash'), false);
      assert.equal(text.includes('pinSalt'), false);
      assert.equal(text.includes('"pin"'), false);
      assert.equal(text.includes(card), false);
    }
    assert.equal(live.json.sub.games.atm.plays.length, 2);
  } finally {
    await t.close();
  }
});

test('an older book carries the purse ceiling into the ATM', async () => {
  const t = await boot({
    settings: { tiers: [] },
    subs: [{
      id: 'abcd1234',
      handle: 'olden',
      title: 'sub',
      passSalt: 'x',
      passHash: 'y',
      createdAt: '2025-01-01T00:00:00.000Z',
      sentCents: 0,
      tributeCents: 0,
      askCents: 0,
      purseCapCents: 7_500,
      purseDrawnCents: 2_500,
      hideFromHall: false,
      debt: null,
      tasks: [],
      entries: [],
    }],
    sessions: [],
    invoices: [],
  });
  try {
    const studio = jar();
    await studio.call(t.port, 'POST', '/api/studio/login', { pin: 'studio-pin-test' });
    const book = await studio.call(t.port, 'GET', '/api/studio');
    const sub = book.json.subs[0];
    assert.deepEqual([sub.atm.loadedCents, sub.atm.withdrawnCents, sub.atm.balanceCents], [7_500, 2_500, 5_000]);
    assert.equal('purseCapCents' in sub, false);
  } finally {
    await t.close();
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
