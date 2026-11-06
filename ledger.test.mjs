import assert from 'node:assert/strict';
import test from 'node:test';
import { accrue, applyConfirmedPayment, previousDue } from './ledger.mjs';
import { mapLndInvoice, satsForCents } from './ohm.mjs';

function debtSub(overrides = {}) {
  return {
    entries: [],
    sentCents: 0,
    tributeCents: 0,
    askCents: 0,
    debt: {
      status: 'active',
      balanceCents: 100_000,
      apr: 36.5,
      accruedThrough: '2026-01-01',
      lateFeeCents: 500,
      minPaymentCents: 1_000,
      dueDay: 15,
      lateFeesApplied: [],
      signedAt: '2026-01-01T15:00:00.000Z',
      ...overrides,
    },
  };
}

test('daily interest posts on the following New York morning and compounds', () => {
  const sub = debtSub({ lateFeeCents: 0, minPaymentCents: 0 });
  const added = accrue(sub, new Date('2026-01-03T17:00:00.000Z'));
  assert.equal(added.length, 2);
  assert.equal(added[0].amountCents, 100);
  assert.equal(added[1].amountCents, 100);
  assert.equal(sub.debt.balanceCents, 100_200);
  assert.equal(sub.debt.accruedThrough, '2026-01-03');
  assert.equal(accrue(sub, new Date('2026-01-03T17:00:00.000Z')).length, 0);
});

test('a proposed or paused debt does not accrue', () => {
  for (const status of ['proposed', 'paused', 'settled']) {
    const sub = debtSub({ status, balanceCents: status === 'proposed' ? 0 : 100_000 });
    assert.deepEqual(accrue(sub, new Date('2026-03-01T17:00:00.000Z')), []);
  }
});

test('late fee posts once the morning after a missed due date', () => {
  const sub = debtSub({ apr: 0, balanceCents: 4_000 });
  const added = accrue(sub, new Date('2026-01-16T17:00:00.000Z'));
  assert.equal(added.length, 1);
  assert.equal(added[0].kind, 'late_fee');
  assert.equal(sub.debt.balanceCents, 4_500);
  assert.deepEqual(sub.debt.lateFeesApplied, ['2026-01-15']);
  assert.equal(accrue(sub, new Date('2026-01-20T17:00:00.000Z')).length, 0);
});

test('a minimum paid by the due date blocks the late fee', () => {
  const sub = debtSub({ apr: 0, balanceCents: 4_000 });
  sub.entries.push({
    status: 'confirmed',
    purpose: 'debt',
    kind: 'payment',
    appliedDebtCents: 1_000,
    nyDay: '2026-01-15',
  });
  const added = accrue(sub, new Date('2026-01-16T17:00:00.000Z'));
  assert.equal(added.length, 0);
  assert.equal(sub.debt.balanceCents, 4_000);
  assert.equal(previousDue('2026-01-15', 15), '2025-12-15');
});

test('debt payments reduce the balance and the extra is tribute', () => {
  const sub = debtSub({ balanceCents: 1_500 });
  sub.askCents = 200;
  const applied = applyConfirmedPayment(sub, 2_000, 'debt');
  assert.equal(applied.appliedDebtCents, 1_500);
  assert.equal(applied.appliedTributeCents, 500);
  assert.equal(sub.debt.balanceCents, 0);
  assert.equal(sub.tributeCents, 500);
  assert.equal(sub.askCents, 0);
  assert.equal(sub.sentCents, 2_000);
});

test('sats are priced from the bitcoin rate and refuse a nonsense price', () => {
  assert.equal(satsForCents(10_000, 100_000), 100_000);
  assert.equal(satsForCents(100, 96_000), 1_042);
  assert.throws(() => satsForCents(100, 10), /price/i);
});

test('lightning invoice states map without treating an open invoice as paid', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(mapLndInvoice({ settled: true, state: 'SETTLED', amt_paid_sat: '5' }, now).status, 'paid');
  assert.equal(
    mapLndInvoice({ settled: false, state: 'OPEN', creation_date: '1767225600', expiry: '3600' }, now).status,
    'pending',
  );
  assert.equal(mapLndInvoice({ settled: false, state: 'CANCELED', creation_date: '1', expiry: '1' }, now).status, 'cancelled');
});
