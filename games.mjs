/**
 * Games decide an amount owed. Every outcome is a positive charge that lands on
 * an active signed debt, so the best result is the smallest charge. Nothing here
 * pays out, refunds, or lowers a balance.
 *
 * Odds are exact fractions of the weights. Draws use node:crypto randomInt, and
 * the caller saves each draw before showing it.
 */

import { randomInt } from 'node:crypto';
import { dueDate, LIMITS, money, nyDate, previousDue } from './ledger.mjs';

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const GAMES = { slot: 'Slot machine', atm: 'Human ATM' };

export const SLOT_SYMBOLS = ['gem', 'ring', 'pearl', 'heart', 'lock', 'crown', 'star', 'rose'];

export const ATM_OPTIONS = ['amount', 'quick', 'skim', 'kick'];

export function defaultSlotTerms() {
  return {
    symbols: [
      { id: 'gem', weight: 1 },
      { id: 'ring', weight: 2 },
      { id: 'pearl', weight: 3 },
      { id: 'heart', weight: 3 },
      { id: 'lock', weight: 3 },
    ],
    stakeCents: 1_000,
    payouts: [
      { match: 'three', symbol: 'gem', multiplierPct: 500 },
      { match: 'three', symbol: null, multiplierPct: 300 },
      { match: 'two', symbol: null, multiplierPct: 200 },
      { match: 'other', symbol: null, multiplierPct: 100 },
    ],
    perPlayCapCents: 5_000,
    dailyCapCents: 20_000,
    cooldownSeconds: 30,
  };
}

export function defaultAtmTerms() {
  return {
    quickCents: 2_000,
    skimMinCents: 500,
    skimMaxCents: 4_000,
    kick: [
      { amountCents: 500, weight: 5 },
      { amountCents: 2_000, weight: 3 },
      { amountCents: 5_000, weight: 2 },
    ],
    perPlayCapCents: 10_000,
    dailyCapCents: 30_000,
    cooldownSeconds: 60,
  };
}

function intIn(value, min, max, message) {
  if (!Number.isInteger(value) || value < min || value > max) throw new GameError(message);
  return value;
}

function centsIn(value, min, max, label) {
  return intIn(value, min, max, `${label} must be between ${money(min)} and ${money(max)}.`);
}

function plural(symbol) {
  return `${symbol}s`;
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

function fractionOf(numerator, denominator) {
  const d = gcd(numerator, denominator);
  return `${numerator / d}/${denominator / d}`;
}

function averageOf(numerator, denominator) {
  return { numerator, denominator, fraction: fractionOf(numerator, denominator), cents: Math.round(numerator / denominator) };
}

/** A reduced fraction, plus a percent rounded to two places and whether that percent is exact. */
export function share(numerator, denominator) {
  return {
    numerator,
    denominator,
    fraction: fractionOf(numerator, denominator),
    percent: Math.round((numerator * 10_000) / denominator) / 100,
    exact: (numerator * 10_000) % denominator === 0,
  };
}

export function normalizeLimits(input) {
  const perPlayCapCents = centsIn(input.perPlayCapCents, LIMITS.minCheckoutCents, LIMITS.maxGamePlayCents, 'The per-play cap');
  const dailyCapCents = centsIn(input.dailyCapCents, LIMITS.minCheckoutCents, LIMITS.maxGameDailyCents, 'The daily cap');
  if (dailyCapCents < perPlayCapCents) throw new GameError('The daily cap cannot sit below the per-play cap.');
  const cooldownSeconds = intIn(
    input.cooldownSeconds,
    LIMITS.minGameCooldownSeconds,
    LIMITS.maxGameCooldownSeconds,
    `The cooldown must be from ${LIMITS.minGameCooldownSeconds} seconds to ${LIMITS.maxGameCooldownSeconds / 3600} hours.`,
  );
  return { perPlayCapCents, dailyCapCents, cooldownSeconds };
}

export function normalizeSlotTerms(input) {
  if (!input || typeof input !== 'object') throw new GameError('Send the slot machine terms.');
  const symbols = Array.isArray(input.symbols) ? input.symbols : [];
  if (symbols.length < 2 || symbols.length > LIMITS.maxSlotSymbols) {
    throw new GameError(`Use 2 to ${LIMITS.maxSlotSymbols} symbols.`);
  }
  const seen = new Set();
  const cleanSymbols = symbols.map((symbol) => {
    const id = String(symbol?.id || '');
    if (!SLOT_SYMBOLS.includes(id) || seen.has(id)) throw new GameError('Pick each symbol once, from the list.');
    seen.add(id);
    return {
      id,
      weight: intIn(symbol.weight, 1, LIMITS.maxSlotWeight, `Each weight must be a whole number from 1 to ${LIMITS.maxSlotWeight}.`),
    };
  });
  const stakeCents = centsIn(input.stakeCents, LIMITS.minCheckoutCents, LIMITS.maxGameStakeCents, 'The stake');
  const payouts = Array.isArray(input.payouts) ? input.payouts : [];
  if (payouts.length < 1 || payouts.length > LIMITS.maxPayoutRules) {
    throw new GameError(`Use 1 to ${LIMITS.maxPayoutRules} payout lines.`);
  }
  const keys = new Set();
  const cleanPayouts = payouts.map((rule, index) => {
    const match = rule?.match;
    if (!['three', 'two', 'other'].includes(match)) throw new GameError('Each payout line matches three, two, or anything else.');
    const symbol = rule.symbol == null || rule.symbol === '' || match === 'other' ? null : String(rule.symbol);
    if (symbol && !seen.has(symbol)) throw new GameError('A payout line names a symbol that is not on the reels.');
    if ((match === 'other') !== (index === payouts.length - 1)) {
      throw new GameError('End the payout table with one "anything else" line.');
    }
    const key = `${match}:${symbol || '*'}`;
    if (keys.has(key)) throw new GameError('Each payout line must be different.');
    keys.add(key);
    return {
      match,
      symbol,
      multiplierPct: intIn(
        rule.multiplierPct,
        LIMITS.minMultiplierPct,
        LIMITS.maxMultiplierPct,
        `Multipliers run from ${LIMITS.minMultiplierPct / 100}x to ${LIMITS.maxMultiplierPct / 100}x the stake. A game only adds.`,
      ),
    };
  });
  return { symbols: cleanSymbols, stakeCents, payouts: cleanPayouts, ...normalizeLimits(input) };
}

export function normalizeAtmTerms(input) {
  if (!input || typeof input !== 'object') throw new GameError('Send the ATM terms.');
  const limits = normalizeLimits(input);
  const cap = limits.perPlayCapCents;
  const quickCents = centsIn(input.quickCents, LIMITS.minCheckoutCents, cap, 'The quick amount');
  const skimMinCents = centsIn(input.skimMinCents, LIMITS.minCheckoutCents, cap, 'The smallest skim');
  const skimMaxCents = centsIn(input.skimMaxCents, skimMinCents, cap, 'The largest skim');
  const kick = Array.isArray(input.kick) ? input.kick : [];
  if (kick.length < 1 || kick.length > LIMITS.maxKickOutcomes) {
    throw new GameError(`Give the kick 1 to ${LIMITS.maxKickOutcomes} outcomes.`);
  }
  const amounts = new Set();
  const cleanKick = kick.map((item) => {
    const amountCents = centsIn(item?.amountCents, LIMITS.minCheckoutCents, cap, 'Each kick amount');
    if (amounts.has(amountCents)) throw new GameError('Each kick amount must be different.');
    amounts.add(amountCents);
    return {
      amountCents,
      weight: intIn(item.weight, 1, LIMITS.maxKickWeight, `Each kick weight must be a whole number from 1 to ${LIMITS.maxKickWeight}.`),
    };
  });
  return { quickCents, skimMinCents, skimMaxCents, kick: cleanKick, ...limits };
}

export function normalizeTerms(key, input) {
  if (key === 'slot') return normalizeSlotTerms(input);
  if (key === 'atm') return normalizeAtmTerms(input);
  throw new GameError('That game is not in the book.', 404);
}

export function gameKeyOf(value) {
  if (!Object.hasOwn(GAMES, value)) throw new GameError('That game is not in the book.', 404);
  return value;
}

function reelCounts(reels) {
  const counts = {};
  for (const id of reels) counts[id] = (counts[id] || 0) + 1;
  return counts;
}

export function slotRuleMatches(rule, reels) {
  if (rule.match === 'other') return true;
  const counts = reelCounts(reels);
  const n = rule.match === 'three' ? 3 : 2;
  if (rule.symbol) return counts[rule.symbol] === n;
  return Object.values(counts).some((count) => count === n);
}

export function slotOutcomeIndex(terms, reels) {
  return terms.payouts.findIndex((rule) => slotRuleMatches(rule, reels));
}

export function slotRuleLabel(rule) {
  if (rule.match === 'three') return rule.symbol ? `Three ${plural(rule.symbol)}` : 'Any three of a kind';
  if (rule.match === 'two') return rule.symbol ? `Exactly two ${plural(rule.symbol)}` : 'Any two matching';
  return 'Anything else';
}

function chargeOf(stakeCents, multiplierPct, capCents) {
  const raw = Math.round((stakeCents * multiplierPct) / 100);
  return { chargeCents: Math.min(raw, capCents), capped: raw > capCents };
}

function riggedLine(outcomes, stakeCents, play) {
  const live = outcomes.filter((item) => item.numerator > 0);
  const denominator = live[0].denominator;
  const big = live.filter((item) => item.chargeCents > stakeCents).reduce((sum, item) => sum + item.numerator, 0);
  const total = live.reduce((sum, item) => sum + item.numerator * item.chargeCents, 0);
  if (big * 2 >= denominator) {
    return `Rigged in her favor: you lose big ${share(big, denominator).percent}% of the time.`;
  }
  if (total > stakeCents * denominator) {
    return `Tilted her way: the average ${play} costs more than the ${money(stakeCents)} stake.`;
  }
  return `Gentle for now: you pay the stake or less ${share(denominator - big, denominator).percent}% of the time.`;
}

/**
 * Exact odds for three independent reels. Each reel lands on a symbol with
 * probability weight / total, so every combination has probability
 * wa * wb * wc / total^3 and the outcomes sum to exactly total^3.
 */
export function slotOdds(terms, perPlayCapCents = Number.MAX_SAFE_INTEGER) {
  const total = terms.symbols.reduce((sum, symbol) => sum + symbol.weight, 0);
  const denominator = total ** 3;
  const numerators = terms.payouts.map(() => 0);
  for (const a of terms.symbols) {
    for (const b of terms.symbols) {
      for (const c of terms.symbols) {
        numerators[slotOutcomeIndex(terms, [a.id, b.id, c.id])] += a.weight * b.weight * c.weight;
      }
    }
  }
  const outcomes = terms.payouts.map((rule, index) => ({
    label: slotRuleLabel(rule),
    match: rule.match,
    symbol: rule.symbol,
    multiplierPct: rule.multiplierPct,
    ...chargeOf(terms.stakeCents, rule.multiplierPct, perPlayCapCents),
    ...share(numerators[index], denominator),
  }));
  const live = outcomes.filter((item) => item.numerator > 0);
  const averageNumerator = live.reduce((sum, item) => sum + item.numerator * item.chargeCents, 0);
  return {
    stakeCents: terms.stakeCents,
    reels: terms.symbols.map((symbol) => ({ id: symbol.id, weight: symbol.weight, ...share(symbol.weight, total) })),
    outcomes,
    denominator,
    average: averageOf(averageNumerator, denominator),
    minChargeCents: Math.min(...live.map((item) => item.chargeCents)),
    maxChargeCents: Math.max(...live.map((item) => item.chargeCents)),
    rigged: riggedLine(outcomes, terms.stakeCents, 'spin'),
  };
}

export function atmOdds(terms) {
  const kickTotal = terms.kick.reduce((sum, item) => sum + item.weight, 0);
  const kick = terms.kick.map((item) => ({ amountCents: item.amountCents, weight: item.weight, ...share(item.weight, kickTotal) }));
  const kickAverage = kick.reduce((sum, item) => sum + item.weight * item.amountCents, 0);
  const top = kick.reduce((best, item) => (item.amountCents > best.amountCents ? item : best), kick[0]);
  const skimCount = terms.skimMaxCents - terms.skimMinCents + 1;
  const topShare = share(top.weight, kickTotal);
  let rigged = `The biggest kick, ${money(top.amountCents)}, lands ${topShare.percent}% of the time.`;
  if (top.weight * 2 >= kickTotal && kick.length > 1) {
    rigged = `Rigged in her favor: a kick costs you the top ${money(top.amountCents)} ${topShare.percent}% of the time.`;
  }
  return {
    quick: { amountCents: terms.quickCents },
    skim: {
      minCents: terms.skimMinCents,
      maxCents: terms.skimMaxCents,
      each: share(1, skimCount),
      average: averageOf(terms.skimMinCents + terms.skimMaxCents, 2),
    },
    kick: {
      outcomes: kick,
      denominator: kickTotal,
      average: averageOf(kickAverage, kickTotal),
      minCents: Math.min(...kick.map((item) => item.amountCents)),
      maxCents: top.amountCents,
    },
    rigged,
  };
}

export function pickWeighted(weights, rand = randomInt) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = rand(total);
  for (let index = 0; index < weights.length; index += 1) {
    if (roll < weights[index]) return index;
    roll -= weights[index];
  }
  throw new GameError('The draw fell outside the weights.', 500);
}

export function drawSlot(terms, rand = randomInt) {
  const weights = terms.symbols.map((symbol) => symbol.weight);
  return [0, 1, 2].map(() => terms.symbols[pickWeighted(weights, rand)].id);
}

export function drawSkim(terms, rand = randomInt) {
  return terms.skimMinCents + rand(terms.skimMaxCents - terms.skimMinCents + 1);
}

export function drawKick(terms, rand = randomInt) {
  return terms.kick[pickWeighted(terms.kick.map((item) => item.weight), rand)].amountCents;
}

export function newGame(terms, now) {
  return {
    version: 1,
    acceptedVersion: 0,
    terms,
    proposedAt: now.toISOString(),
    acceptedAt: null,
    pausedBySub: false,
    subPerPlayCapCents: null,
    subDailyCapCents: null,
  };
}

/** Any change by her sends the game back to proposed until he accepts the new version. */
export function reviseGame(game, terms, now) {
  game.version += 1;
  game.terms = terms;
  game.proposedAt = now.toISOString();
  return game;
}

export function acceptGame(game, version, now) {
  if (version !== game.version) {
    throw new GameError('The terms changed while you were reading. Read them again.', 409);
  }
  game.acceptedVersion = game.version;
  game.acceptedAt = now.toISOString();
  return game;
}

export function gameStatus(game) {
  if (!game) return 'none';
  if (game.acceptedVersion !== game.version) return 'proposed';
  if (game.pausedBySub) return 'paused';
  return 'ready';
}

export function effectiveLimits(game) {
  return {
    perPlayCapCents: Math.min(game.terms.perPlayCapCents, game.subPerPlayCapCents ?? Infinity),
    dailyCapCents: Math.min(game.terms.dailyCapCents, game.subDailyCapCents ?? Infinity),
    cooldownSeconds: game.terms.cooldownSeconds,
  };
}

/** He can pause, or set his own caps at or below hers. Clearing a cap returns to the one he accepted. */
export function setSubLimits(game, input) {
  const capOf = (value, ceiling, label) => {
    if (value == null) return null;
    return centsIn(value, LIMITS.minCheckoutCents, ceiling, label);
  };
  if (input.paused !== undefined) game.pausedBySub = Boolean(input.paused);
  if (input.perPlayCapCents !== undefined) {
    game.subPerPlayCapCents = capOf(input.perPlayCapCents, game.terms.perPlayCapCents, 'Your per-play cap');
  }
  if (input.dailyCapCents !== undefined) {
    game.subDailyCapCents = capOf(input.dailyCapCents, game.terms.dailyCapCents, 'Your daily cap');
  }
  return game;
}

export function chargedOn(plays, key, nyDay) {
  return plays.reduce((sum, play) => (play.game === key && play.nyDay === nyDay ? sum + play.amountCents : sum), 0);
}

export function lastPlayOf(plays, key) {
  for (let index = plays.length - 1; index >= 0; index -= 1) {
    if (plays[index].game === key) return plays[index];
  }
  return null;
}

/**
 * Throws unless a play is allowed right now. maxChargeCents is the worst case
 * the play could cost, so a random result can never break a cap.
 */
export function assertPlayable({ sub, key, maxChargeCents, now, today }) {
  const game = sub.games?.[key];
  if (!game) throw new GameError(`She has not set up the ${GAMES[key].toLowerCase()} for this name.`, 404);
  if (game.acceptedVersion !== game.version) {
    throw new GameError('These terms have not been accepted. Read and accept them before playing.', 409);
  }
  if (sub.debt?.status !== 'active') {
    throw new GameError('Games only add to an active signed debt, and none is running.');
  }
  if (game.pausedBySub) throw new GameError('This game is paused.');
  const locks = gameLocks(sub, today, maxChargeCents);
  if (locks.length) throw new GameError(locks[0].message, 423);
  const limits = effectiveLimits(game);
  const last = lastPlayOf(sub.plays, key);
  if (last) {
    const waitMs = Date.parse(last.at) + limits.cooldownSeconds * 1000 - now.getTime();
    if (waitMs > 0) throw new GameError(`Cooldown: wait ${Math.ceil(waitMs / 1000)} more seconds.`, 429);
  }
  if (maxChargeCents > limits.perPlayCapCents) {
    throw new GameError(`That could cost ${money(maxChargeCents)}, over the per-play cap of ${money(limits.perPlayCapCents)}.`);
  }
  const spent = chargedOn(sub.plays, key, today);
  if (spent + maxChargeCents > limits.dailyCapCents) {
    throw new GameError(
      `Today's cap leaves ${money(Math.max(limits.dailyCapCents - spent, 0))}, and this could cost ${money(maxChargeCents)}.`,
    );
  }
  return limits;
}

export function defaultStanding() {
  return { hold: false, lockWhenOverdue: true, minPaidCents: 0, maxUnpaidGameCents: 0 };
}

/** Her rules for who may play. They only ever lock games, so changing them needs no new consent. */
export function normalizeStanding(input = {}, current = defaultStanding()) {
  const next = { ...current };
  if (input.hold !== undefined) next.hold = Boolean(input.hold);
  if (input.lockWhenOverdue !== undefined) next.lockWhenOverdue = Boolean(input.lockWhenOverdue);
  if (input.minPaidCents !== undefined) {
    next.minPaidCents = intIn(input.minPaidCents, 0, LIMITS.maxPrincipalCents,
      `The paid minimum must be from $0.00 to ${money(LIMITS.maxPrincipalCents)}.`);
  }
  if (input.maxUnpaidGameCents !== undefined) {
    next.maxUnpaidGameCents = intIn(input.maxUnpaidGameCents, 0, LIMITS.maxGameDailyCents * 10,
      `The unpaid limit must be from $0.00 to ${money(LIMITS.maxGameDailyCents * 10)}.`);
  }
  return next;
}

/** Real money only: Lightning that settled, payments she recorded, and claims she confirmed. Sample checkouts never count. */
function provenPayment(entry) {
  return entry.status === 'confirmed'
    && (entry.kind === 'payment' || entry.kind === 'tribute')
    && entry.method !== 'sandbox';
}

export function provenPaidCents(entries) {
  return entries.reduce((sum, entry) => (provenPayment(entry) ? sum + entry.amountCents : sum), 0);
}

/**
 * Game charges not yet covered by real debt payments, walked in book order.
 * A forgiven balance takes its game charges with it. A settled one does not.
 */
export function unpaidGameCents(entries) {
  let owed = 0;
  for (const entry of entries) {
    if (entry.kind === 'game') owed += entry.amountCents;
    else if (entry.kind === 'forgive') owed = 0;
    else if (provenPayment(entry) && entry.appliedDebtCents > 0) owed -= Math.min(owed, entry.appliedDebtCents);
  }
  return owed;
}

/** The latest due date before today whose minimum was not met by real payments, counting late ones. */
export function missedMinimum(sub, today) {
  const debt = sub.debt;
  if (!debt || debt.status !== 'active' || !(debt.minPaymentCents > 0) || !(debt.balanceCents > 0) || !debt.signedAt) return null;
  const [year, month] = today.split('-').map(Number);
  let due = dueDate(year, month, debt.dueDay);
  if (due >= today) due = previousDue(due, debt.dueDay);
  if (due < nyDate(new Date(debt.signedAt))) return null;
  const windowStart = previousDue(due, debt.dueDay);
  const paid = (sub.entries || []).reduce((sum, entry) => {
    const day = entry.nyDay || nyDate(new Date(entry.at));
    return provenPayment(entry) && day > windowStart && day <= today ? sum + (entry.appliedDebtCents || 0) : sum;
  }, 0);
  if (paid >= debt.minPaymentCents) return null;
  return { due, minimumCents: debt.minPaymentCents, shortCents: debt.minPaymentCents - paid };
}

/**
 * Every reason games are locked for this name right now, strictest first.
 * extraCents is the worst a pending play could add, so it can never carry him past her unpaid limit.
 */
export function gameLocks(sub, today, extraCents = 0) {
  const rules = sub.standing || defaultStanding();
  const locks = [];
  if (rules.hold) locks.push({ code: 'hold', message: 'She has put games on hold for this name.' });
  if (rules.lockWhenOverdue) {
    const missed = missedMinimum(sub, today);
    if (missed) {
      locks.push({
        code: 'overdue',
        message: `The ${money(missed.minimumCents)} minimum due ${missed.due} was missed. Pay ${money(missed.shortCents)} toward the debt to unlock games.`,
      });
    }
  }
  if (rules.minPaidCents > 0) {
    const paid = provenPaidCents(sub.entries || []);
    if (paid < rules.minPaidCents) {
      locks.push({
        code: 'unproven',
        message: `Games unlock after ${money(rules.minPaidCents - paid)} more is paid. Lightning counts once it settles. Other payments count once she confirms them.`,
      });
    }
  }
  if (rules.maxUnpaidGameCents > 0) {
    const owed = unpaidGameCents(sub.entries || []);
    if (owed >= rules.maxUnpaidGameCents) {
      locks.push({
        code: 'unpaid',
        message: `Unpaid game charges are ${money(owed)}, at her limit of ${money(rules.maxUnpaidGameCents)}. Pay at least ${money(Math.max(owed - rules.maxUnpaidGameCents + 1, LIMITS.minCheckoutCents))} toward the debt to play again.`,
      });
    } else if (owed + extraCents > rules.maxUnpaidGameCents) {
      locks.push({
        code: 'unpaid',
        message: `This could add ${money(extraCents)}, and unpaid game charges would pass her limit of ${money(rules.maxUnpaidGameCents)}. Pay ${money(owed + extraCents - rules.maxUnpaidGameCents)} toward the debt first.`,
      });
    }
  }
  return locks;
}

export function standingView(sub, today) {
  const rules = sub.standing || defaultStanding();
  return {
    rules,
    provenPaidCents: provenPaidCents(sub.entries || []),
    unpaidGameCents: unpaidGameCents(sub.entries || []),
    missed: missedMinimum(sub, today),
    locks: gameLocks(sub, today).map((lock) => lock.message),
  };
}

/** Drops the oldest plays from earlier days once the list is long. Today's plays stay so the daily cap holds. */
export function trimPlays(plays, today) {
  let excess = plays.length - LIMITS.maxPlays;
  while (excess > 0 && plays[0] && plays[0].nyDay !== today) {
    plays.shift();
    excess -= 1;
  }
  return plays;
}

export function newAtm(loadedCents = 0, withdrawnCents = 0) {
  return {
    loadedCents: Math.max(loadedCents, withdrawnCents),
    withdrawnCents,
    frozen: false,
    pinSalt: null,
    pinHash: null,
    pinFails: 0,
    lockedUntil: null,
    card: null,
  };
}

/** Brings an older book forward. The purse ceiling becomes the loaded ATM. */
export function upgradeSub(sub) {
  if (!sub.games || typeof sub.games !== 'object') sub.games = {};
  if (!Array.isArray(sub.plays)) sub.plays = [];
  if (!sub.atm) sub.atm = newAtm(sub.purseCapCents || 0, sub.purseDrawnCents || 0);
  sub.standing = normalizeStanding({}, { ...defaultStanding(), ...(sub.standing || {}) });
  delete sub.purseCapCents;
  delete sub.purseDrawnCents;
  return sub;
}

export function atmLocked(atm, now) {
  return Boolean(atm.lockedUntil && Date.parse(atm.lockedUntil) > now.getTime());
}

export function atmView(atm, now) {
  return {
    loadedCents: atm.loadedCents,
    withdrawnCents: atm.withdrawnCents,
    balanceCents: atm.loadedCents - atm.withdrawnCents,
    frozen: atm.frozen,
    pinSet: Boolean(atm.pinHash),
    lockedUntil: atmLocked(atm, now) ? atm.lockedUntil : null,
    pinTriesLeft: LIMITS.atmPinTries - (atm.pinFails || 0),
  };
}

export function gameView(sub, key, now, today) {
  const game = sub.games?.[key];
  if (!game) return null;
  const limits = effectiveLimits(game);
  const plays = sub.plays.filter((play) => play.game === key);
  const last = plays.at(-1);
  const todayCents = chargedOn(plays, key, today);
  const nextMs = last ? Date.parse(last.at) + limits.cooldownSeconds * 1000 : 0;
  const odds = key === 'slot' ? slotOdds(game.terms, limits.perPlayCapCents) : atmOdds(game.terms);
  return {
    key,
    name: GAMES[key],
    status: gameStatus(game),
    version: game.version,
    acceptedVersion: game.acceptedVersion,
    proposedAt: game.proposedAt,
    acceptedAt: game.acceptedAt,
    terms: game.terms,
    limits,
    subLimits: { perPlayCapCents: game.subPerPlayCapCents, dailyCapCents: game.subDailyCapCents },
    pausedBySub: game.pausedBySub,
    odds,
    todayCents,
    leftTodayCents: Math.max(limits.dailyCapCents - todayCents, 0),
    // A spin always risks its top charge; an ATM withdrawal's depends on the option she picks, so the server checks it then.
    locks: gameLocks(sub, today, key === 'slot' ? odds.maxChargeCents : 0).map((lock) => lock.message),
    nextPlayAt: nextMs > now.getTime() ? new Date(nextMs).toISOString() : null,
    plays: plays.slice(-25),
  };
}
