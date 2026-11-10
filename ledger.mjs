/** Money is integer cents. Calendar days use America/New_York, YYYY-MM-DD. */

export const TIMEZONE = 'America/New_York';

export const LIMITS = {
  minCheckoutCents: 100,
  maxCheckoutCents: 200_000,
  maxTipCents: 200_000,
  maxPayoutCents: 500_000,
  maxAdjustmentCents: 200_000,
  maxHouseCutPercent: 50,
  maxNote: 140,
  maxHandle: 20,
  minHandle: 3,
  minPassphrase: 8,
  maxPassphrase: 72,
  maxDisplayName: 40,
  maxCustomers: 2000,
  maxDancers: 200,
  maxEntries: 20_000,
  maxPackages: 12,
};

/** Shown in-product. Ohm Tracker is a ledger + payment rail, not payroll. */
export const PRODUCT_DISCLAIMER =
  'Ohm Tracker is a club operations ledger and Lightning payment rail. It does not calculate payroll, withhold taxes, classify workers, or act as employer of record. The club (or its merchant entity) is the merchant of record for live Ohm payments and remains responsible for dancer payouts, house share, and tax compliance. Credits are club-issued balances for in-venue top-ups and tips — not bank deposits.';

export function nyDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function money(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, '0');
  return `${sign}$${dollars.toLocaleString('en-US')}.${rem}`;
}

export function clampHouseCutPercent(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > LIMITS.maxHouseCutPercent) {
    throw new Error(`House cut must be an integer from 0 to ${LIMITS.maxHouseCutPercent}.`);
  }
  return n;
}

/** Split a tip into dancer net and house take. */
export function splitTip(amountCents, houseCutPercent) {
  if (!Number.isInteger(amountCents) || amountCents < 1) {
    throw new Error('Tip amount must be a positive integer in cents.');
  }
  const cut = clampHouseCutPercent(houseCutPercent);
  const houseCents = Math.floor((amountCents * cut) / 100);
  const dancerCents = amountCents - houseCents;
  return { amountCents, houseCents, dancerCents, houseCutPercent: cut };
}

export function applyTopUp(customer, amountCents) {
  if (!Number.isInteger(amountCents) || amountCents < 1) {
    throw new Error('Top-up must be a positive integer in cents.');
  }
  customer.creditCents += amountCents;
  return { creditCents: customer.creditCents };
}

export function applyTip(customer, dancer, amountCents, houseCutPercent) {
  if (customer.creditCents < amountCents) {
    throw new Error('Not enough credits for that tip.');
  }
  const split = splitTip(amountCents, houseCutPercent);
  customer.creditCents -= split.amountCents;
  dancer.earnedCents += split.dancerCents;
  return split;
}

export function applyPayout(dancer, amountCents) {
  if (!Number.isInteger(amountCents) || amountCents < 1) {
    throw new Error('Payout must be a positive integer in cents.');
  }
  const unpaid = dancer.earnedCents - dancer.paidOutCents;
  if (amountCents > unpaid) {
    throw new Error('Payout cannot exceed unpaid dancer earnings.');
  }
  dancer.paidOutCents += amountCents;
  return { unpaidCents: dancer.earnedCents - dancer.paidOutCents };
}

export function unpaidCents(dancer) {
  return Math.max(0, (dancer.earnedCents || 0) - (dancer.paidOutCents || 0));
}

export function summarizeLedger(entries) {
  const out = {
    topUpCents: 0,
    tipCents: 0,
    houseCents: 0,
    dancerTipCents: 0,
    payoutCents: 0,
    adjustmentCents: 0,
  };
  for (const entry of entries) {
    if (entry.status !== 'confirmed') continue;
    if (entry.kind === 'topup') out.topUpCents += entry.amountCents;
    else if (entry.kind === 'tip') {
      out.tipCents += entry.amountCents;
      out.houseCents += entry.houseCents || 0;
      out.dancerTipCents += entry.dancerCents || 0;
    } else if (entry.kind === 'payout') out.payoutCents += entry.amountCents;
    else if (entry.kind === 'adjustment') out.adjustmentCents += entry.amountCents;
  }
  return out;
}
