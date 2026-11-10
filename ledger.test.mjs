import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPayout,
  applyTip,
  applyTopUp,
  money,
  splitTip,
  summarizeLedger,
  unpaidCents,
} from './ledger.mjs';

test('money formats cents', () => {
  assert.equal(money(0), '$0.00');
  assert.equal(money(1250), '$12.50');
  assert.equal(money(-99), '-$0.99');
});

test('splitTip floors the house cut', () => {
  assert.deepEqual(splitTip(1000, 20), {
    amountCents: 1000,
    houseCents: 200,
    dancerCents: 800,
    houseCutPercent: 20,
  });
  assert.deepEqual(splitTip(101, 10), {
    amountCents: 101,
    houseCents: 10,
    dancerCents: 91,
    houseCutPercent: 10,
  });
});

test('applyTip moves credits and earnings', () => {
  const customer = { creditCents: 5000 };
  const dancer = { earnedCents: 0, paidOutCents: 0 };
  const split = applyTip(customer, dancer, 2000, 25);
  assert.equal(customer.creditCents, 3000);
  assert.equal(dancer.earnedCents, 1500);
  assert.equal(split.houseCents, 500);
  assert.throws(() => applyTip(customer, dancer, 4000, 0), /Not enough credits/);
});

test('applyTopUp and payout', () => {
  const customer = { creditCents: 0 };
  applyTopUp(customer, 1000);
  assert.equal(customer.creditCents, 1000);

  const dancer = { earnedCents: 800, paidOutCents: 0 };
  applyPayout(dancer, 300);
  assert.equal(dancer.paidOutCents, 300);
  assert.equal(unpaidCents(dancer), 500);
  assert.throws(() => applyPayout(dancer, 600), /unpaid/);
});

test('summarizeLedger totals confirmed rows', () => {
  const summary = summarizeLedger([
    { kind: 'topup', status: 'confirmed', amountCents: 5000 },
    { kind: 'tip', status: 'confirmed', amountCents: 2000, houseCents: 400, dancerCents: 1600 },
    { kind: 'payout', status: 'confirmed', amountCents: 500 },
    { kind: 'tip', status: 'pending', amountCents: 999 },
  ]);
  assert.deepEqual(summary, {
    topUpCents: 5000,
    tipCents: 2000,
    houseCents: 400,
    dancerTipCents: 1600,
    payoutCents: 500,
    adjustmentCents: 0,
  });
});
