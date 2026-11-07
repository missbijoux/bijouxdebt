/** Money is integer cents. Dates are America/New_York calendar days, YYYY-MM-DD. */

export const TIMEZONE = 'America/New_York';

export const LIMITS = {
  minCheckoutCents: 100,
  maxCheckoutCents: 200_000,
  maxPrincipalCents: 2_000_000,
  maxApr: 120,
  maxLateFeeCents: 25_000,
  maxSelfChargeCents: 50_000,
  maxAtmCents: 500_000,
  maxPenaltyCents: 50_000,
  maxGameStakeCents: 50_000,
  maxGamePlayCents: 100_000,
  maxGameDailyCents: 300_000,
  minGameCooldownSeconds: 5,
  maxGameCooldownSeconds: 86_400,
  minMultiplierPct: 10,
  maxMultiplierPct: 10_000,
  maxSlotSymbols: 8,
  maxSlotWeight: 100,
  maxPayoutRules: 12,
  maxKickOutcomes: 6,
  maxKickWeight: 100,
  atmPinTries: 3,
  atmLockMinutes: 15,
  atmCardMinutes: 10,
  maxPlays: 1000,
  maxNote: 140,
  maxHandle: 20,
  minHandle: 3,
  minPassphrase: 8,
  maxPassphrase: 72,
  maxSubs: 300,
  maxEntries: 5000,
  maxTasks: 200,
};

export function nyDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function dueDate(year, month, dueDay) {
  const day = Math.min(dueDay, daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isDueDate(iso, dueDay) {
  const [y, m] = iso.split('-').map(Number);
  return iso === dueDate(y, m, dueDay);
}

export function previousDue(dueIso, dueDay) {
  const [y, m] = dueIso.split('-').map(Number);
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return dueDate(py, pm, dueDay);
}

export function money(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const dollars = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, '0');
  return `${sign}$${dollars.toLocaleString('en-US')}.${rem}`;
}

export function entryDay(entry) {
  if (entry.nyDay) return entry.nyDay;
  return nyDate(new Date(entry.at));
}

function debtPaidBetween(entries, afterIso, throughIso) {
  return entries.reduce((sum, entry) => {
    if (entry.status !== 'confirmed' || entry.purpose !== 'debt' || entry.kind !== 'payment') {
      return sum;
    }
    const day = entryDay(entry);
    if (day > afterIso && day <= throughIso) {
      return sum + (entry.appliedDebtCents ?? 0);
    }
    return sum;
  }, 0);
}

/**
 * Posts daily interest and a once-a-month late fee on an active signed debt.
 * Interest for a calendar day posts on the following New York morning.
 * The late fee posts the morning after the due date when the minimum was not paid.
 * A paused, proposed, or settled debt does not move.
 */
export function accrue(sub, now = new Date()) {
  const added = [];
  const debt = sub.debt;
  if (!debt || debt.status !== 'active') return added;

  const today = nyDate(now);
  if (!debt.accruedThrough) debt.accruedThrough = today;
  if (!Array.isArray(debt.lateFeesApplied)) debt.lateFeesApplied = [];

  let guard = 0;
  while (debt.accruedThrough < today && guard < 4000) {
    const elapsed = debt.accruedThrough;
    const owedBefore = debt.balanceCents;

    if (owedBefore > 0 && debt.apr > 0) {
      const interest = Math.round((owedBefore * debt.apr) / 100 / 365);
      if (interest > 0) {
        debt.balanceCents += interest;
        added.push({
          kind: 'interest',
          amountCents: interest,
          purpose: 'debt',
          status: 'confirmed',
          source: 'clock',
          note: `Daily interest at ${debt.apr}%`,
          nyDay: addDays(elapsed, 1),
        });
      }
    }

    const signedDay = debt.signedAt ? nyDate(new Date(debt.signedAt)) : elapsed;
    if (
      owedBefore > 0 &&
      debt.minPaymentCents > 0 &&
      debt.lateFeeCents > 0 &&
      isDueDate(elapsed, debt.dueDay) &&
      elapsed >= signedDay &&
      !debt.lateFeesApplied.includes(elapsed)
    ) {
      const paid = debtPaidBetween(sub.entries, previousDue(elapsed, debt.dueDay), elapsed);
      if (paid < debt.minPaymentCents) {
        debt.balanceCents += debt.lateFeeCents;
        debt.lateFeesApplied.push(elapsed);
        added.push({
          kind: 'late_fee',
          amountCents: debt.lateFeeCents,
          purpose: 'debt',
          status: 'confirmed',
          source: 'clock',
          note: `Late fee. Minimum ${money(debt.minPaymentCents)} was not met by ${elapsed}.`,
          nyDay: addDays(elapsed, 1),
        });
      } else {
        debt.lateFeesApplied.push(elapsed);
      }
    }

    debt.accruedThrough = addDays(elapsed, 1);
    guard += 1;
  }

  return added;
}

/**
 * Applies a confirmed payment. Debt payments reduce an active balance.
 * Anything past a zero balance, and every tribute, counts as tribute sent
 * and pays down an open ask first.
 */
export function applyConfirmedPayment(sub, amountCents, purpose) {
  const applied = {
    appliedDebtCents: 0,
    appliedTributeCents: 0,
    appliedAskCents: 0,
    purpose: purpose === 'debt' ? 'debt' : 'tribute',
  };
  sub.sentCents += amountCents;

  if (applied.purpose === 'debt' && sub.debt?.status === 'active') {
    const toDebt = Math.min(sub.debt.balanceCents, amountCents);
    sub.debt.balanceCents -= toDebt;
    const extra = amountCents - toDebt;
    sub.tributeCents += extra;
    const toAsk = Math.min(sub.askCents, extra);
    sub.askCents -= toAsk;
    applied.appliedDebtCents = toDebt;
    applied.appliedTributeCents = extra;
    applied.appliedAskCents = toAsk;
    return applied;
  }

  const toAsk = Math.min(sub.askCents, amountCents);
  sub.askCents -= toAsk;
  sub.tributeCents += amountCents;
  applied.purpose = 'tribute';
  applied.appliedAskCents = toAsk;
  applied.appliedTributeCents = amountCents;
  return applied;
}

export function nextDueLabel(debt, now = new Date()) {
  if (!debt || debt.status === 'settled' || debt.status === 'proposed') return null;
  const today = nyDate(now);
  const [y, m] = today.split('-').map(Number);
  let due = dueDate(y, m, debt.dueDay);
  if (due < today) {
    const nm = m === 12 ? 1 : m + 1;
    const ny = m === 12 ? y + 1 : y;
    due = dueDate(ny, nm, debt.dueDay);
  }
  return due;
}
