import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptGame,
  assertPlayable,
  atmOdds,
  defaultAtmTerms,
  defaultSlotTerms,
  drawKick,
  drawSkim,
  drawSlot,
  effectiveLimits,
  gameStatus,
  newGame,
  normalizeAtmTerms,
  normalizeSlotTerms,
  pickWeighted,
  reviseGame,
  setSubLimits,
  slotOdds,
  slotOutcomeIndex,
  trimPlays,
  upgradeSub,
} from './games.mjs';
import { LIMITS } from './ledger.mjs';

const NOW = new Date('2026-03-02T17:00:00.000Z');
const TODAY = '2026-03-02';

function twoSymbolTerms(overrides = {}) {
  return normalizeSlotTerms({
    ...defaultSlotTerms(),
    symbols: [{ id: 'gem', weight: 1 }, { id: 'ring', weight: 1 }],
    perPlayCapCents: 10_000,
    dailyCapCents: 20_000,
    ...overrides,
  });
}

function playableSub(terms = twoSymbolTerms()) {
  const game = newGame(terms, NOW);
  acceptGame(game, 1, NOW);
  return {
    debt: { status: 'active', balanceCents: 10_000 },
    games: { slot: game },
    plays: [],
  };
}

test('slot odds are exact fractions of the weights and sum to one', () => {
  const odds = slotOdds(twoSymbolTerms());
  assert.equal(odds.denominator, 8);
  assert.deepEqual(odds.outcomes.map((item) => item.numerator), [1, 1, 6, 0]);
  assert.deepEqual(odds.outcomes.map((item) => item.percent), [12.5, 12.5, 75, 0]);
  assert.ok(odds.outcomes.every((item) => item.exact));
  assert.equal(odds.average.numerator, 5_000 + 3_000 + 6 * 2_000);
  assert.equal(odds.average.fraction, '2500/1');
  assert.equal(odds.average.cents, 2_500);
  assert.equal(odds.minChargeCents, 2_000);
  assert.equal(odds.maxChargeCents, 5_000);
  assert.match(odds.rigged, /^Rigged in her favor: you lose big 100% of the time\.$/);

  const uneven = slotOdds(normalizeSlotTerms(defaultSlotTerms()));
  assert.equal(uneven.denominator, 12 ** 3);
  assert.deepEqual(uneven.outcomes.map((item) => item.numerator), [1, 89, 882, 756]);
  assert.equal(uneven.outcomes.reduce((sum, item) => sum + item.numerator, 0), uneven.denominator);
  assert.equal(uneven.outcomes[2].fraction, '49/96');
  assert.equal(uneven.outcomes[2].percent, 51.04);
  assert.equal(uneven.outcomes[2].exact, false);
  assert.equal(uneven.average.numerator, 1 * 5_000 + 89 * 3_000 + 882 * 2_000 + 756 * 1_000);
  assert.deepEqual(uneven.reels.map((reel) => reel.fraction), ['1/12', '1/6', '1/4', '1/4', '1/4']);
});

test('the per-play cap clamps a charge, and the odds show the clamped amount', () => {
  const odds = slotOdds(twoSymbolTerms(), 3_000);
  assert.deepEqual(odds.outcomes.map((item) => item.chargeCents), [3_000, 3_000, 2_000, 1_000]);
  assert.equal(odds.outcomes[0].capped, true);
  assert.equal(odds.average.numerator, 3_000 + 3_000 + 6 * 2_000);
});

test('each weighted roll maps to exactly weight-many results', () => {
  const weights = [1, 2, 3, 4];
  const hits = [0, 0, 0, 0];
  for (let roll = 0; roll < 10; roll += 1) hits[pickWeighted(weights, () => roll)] += 1;
  assert.deepEqual(hits, weights);

  const terms = normalizeSlotTerms(defaultSlotTerms());
  const rolls = [0, 1, 11];
  const reels = drawSlot(terms, (max) => {
    assert.equal(max, 12);
    return rolls.shift();
  });
  assert.deepEqual(reels, ['gem', 'ring', 'lock']);
  assert.equal(terms.payouts[slotOutcomeIndex(terms, reels)].match, 'other');
  assert.equal(slotOutcomeIndex(terms, ['gem', 'gem', 'gem']), 0);
  assert.equal(slotOutcomeIndex(terms, ['ring', 'ring', 'ring']), 1);
  assert.equal(slotOutcomeIndex(terms, ['ring', 'lock', 'ring']), 2);
});

test('a game can only add: no zero, negative, or missing charge is accepted', () => {
  for (const multiplierPct of [0, -100, 5, 1.5, null]) {
    assert.throws(
      () => twoSymbolTerms({ payouts: [{ match: 'other', multiplierPct }] }),
      /Multipliers run from/,
    );
  }
  assert.throws(() => twoSymbolTerms({ stakeCents: -500 }), /stake/);
  assert.throws(() => twoSymbolTerms({ stakeCents: 0 }), /stake/);
  assert.throws(
    () => twoSymbolTerms({ payouts: [{ match: 'other', multiplierPct: 100 }, { match: 'two', multiplierPct: 200 }] }),
    /End the payout table/,
  );
  assert.throws(() => twoSymbolTerms({ stakeCents: LIMITS.maxGameStakeCents + 1 }), /stake/);
  assert.throws(() => twoSymbolTerms({ perPlayCapCents: LIMITS.maxGamePlayCents + 1 }), /per-play cap/);
  assert.throws(() => twoSymbolTerms({ dailyCapCents: LIMITS.maxGameDailyCents + 1 }), /daily cap/);
  assert.throws(() => twoSymbolTerms({ cooldownSeconds: 1 }), /cooldown/);
  assert.throws(() => normalizeAtmTerms({ ...defaultAtmTerms(), skimMinCents: -100 }), /smallest skim/);
  assert.throws(() => normalizeAtmTerms({ ...defaultAtmTerms(), kick: [{ amountCents: 0, weight: 1 }] }), /kick amount/);

  const odds = slotOdds(normalizeSlotTerms(defaultSlotTerms()));
  assert.ok(odds.outcomes.every((item) => item.chargeCents > 0));
});

test('caps, cooldowns, and the daily cap hold', () => {
  const sub = playableSub();
  assert.deepEqual(assertPlayable({ sub, key: 'slot', maxChargeCents: 5_000, now: NOW, today: TODAY }), {
    perPlayCapCents: 10_000,
    dailyCapCents: 20_000,
    cooldownSeconds: 30,
  });
  assert.throws(() => assertPlayable({ sub, key: 'slot', maxChargeCents: 10_001, now: NOW, today: TODAY }), /per-play cap/);

  sub.plays.push({ game: 'slot', at: NOW.toISOString(), nyDay: TODAY, amountCents: 16_000 });
  const soon = new Date(NOW.getTime() + 10_000);
  assert.throws(
    () => assertPlayable({ sub, key: 'slot', maxChargeCents: 1_000, now: soon, today: TODAY }),
    (error) => error.status === 429 && /20 more seconds/.test(error.message),
  );
  const later = new Date(NOW.getTime() + 30_000);
  assert.throws(() => assertPlayable({ sub, key: 'slot', maxChargeCents: 5_000, now: later, today: TODAY }), /Today's cap leaves \$40\.00/);
  assertPlayable({ sub, key: 'slot', maxChargeCents: 4_000, now: later, today: TODAY });
  assertPlayable({ sub, key: 'slot', maxChargeCents: 5_000, now: later, today: '2026-03-03' });

  setSubLimits(sub.games.slot, { perPlayCapCents: 2_000, dailyCapCents: 17_000 });
  assert.deepEqual(effectiveLimits(sub.games.slot), { perPlayCapCents: 2_000, dailyCapCents: 17_000, cooldownSeconds: 30 });
  assert.throws(() => assertPlayable({ sub, key: 'slot', maxChargeCents: 2_000, now: later, today: TODAY }), /Today's cap/);
  assert.throws(() => setSubLimits(sub.games.slot, { perPlayCapCents: 10_001 }), /Your per-play cap/);
  setSubLimits(sub.games.slot, { perPlayCapCents: null, dailyCapCents: null });
  assert.equal(effectiveLimits(sub.games.slot).perPlayCapCents, 10_000);

  setSubLimits(sub.games.slot, { paused: true });
  assert.throws(() => assertPlayable({ sub, key: 'slot', maxChargeCents: 100, now: later, today: '2026-03-03' }), /paused/);
  setSubLimits(sub.games.slot, { paused: false });

  for (const status of ['proposed', 'paused', 'settled']) {
    sub.debt.status = status;
    assert.throws(() => assertPlayable({ sub, key: 'slot', maxChargeCents: 100, now: later, today: '2026-03-03' }), /active signed debt/);
  }
  sub.debt = null;
  assert.throws(() => assertPlayable({ sub, key: 'slot', maxChargeCents: 100, now: later, today: '2026-03-03' }), /active signed debt/);
});

test('any edit by her sends the game back to proposed until he accepts the new version', () => {
  const sub = playableSub();
  const game = sub.games.slot;
  assert.equal(gameStatus(game), 'ready');
  reviseGame(game, twoSymbolTerms({ stakeCents: 2_000 }), NOW);
  assert.equal(gameStatus(game), 'proposed');
  assert.throws(() => assertPlayable({ sub, key: 'slot', maxChargeCents: 100, now: NOW, today: TODAY }), /accepted/);
  assert.throws(() => acceptGame(game, 1, NOW), (error) => error.status === 409);
  acceptGame(game, 2, NOW);
  assert.equal(gameStatus(game), 'ready');
  assert.equal(gameStatus(undefined), 'none');
});

test('ATM odds are exact and every draw stays inside her range', () => {
  const terms = normalizeAtmTerms(defaultAtmTerms());
  const odds = atmOdds(terms);
  assert.deepEqual(odds.kick.outcomes.map((item) => item.percent), [50, 30, 20]);
  assert.equal(odds.kick.average.numerator, 5 * 500 + 3 * 2_000 + 2 * 5_000);
  assert.equal(odds.kick.average.cents, 1_850);
  assert.equal(odds.skim.average.cents, 2_250);
  assert.equal(odds.skim.each.denominator, 3_501);
  assert.match(odds.rigged, /biggest kick, \$50\.00, lands 20%/);
  assert.equal(drawSkim(terms, () => 0), 500);
  assert.equal(drawSkim(terms, (max) => max - 1), 4_000);
  assert.equal(drawKick(terms, () => 9), 5_000);
  const rigged = atmOdds(normalizeAtmTerms({ ...defaultAtmTerms(), kick: [{ amountCents: 500, weight: 3 }, { amountCents: 5_000, weight: 7 }] }));
  assert.equal(rigged.rigged, 'Rigged in her favor: a kick costs you the top $50.00 70% of the time.');
});

test('an older book moves the purse into the ATM, and old plays trim without losing today', () => {
  const sub = upgradeSub({ purseCapCents: 5_000, purseDrawnCents: 1_200 });
  assert.equal(sub.atm.loadedCents, 5_000);
  assert.equal(sub.atm.withdrawnCents, 1_200);
  assert.equal('purseCapCents' in sub, false);
  assert.deepEqual(sub.games, {});

  const plays = [];
  for (let i = 0; i < LIMITS.maxPlays + 5; i += 1) plays.push({ nyDay: i < 3 ? '2026-03-01' : TODAY });
  trimPlays(plays, TODAY);
  assert.equal(plays.length, LIMITS.maxPlays + 2);
  assert.ok(plays.every((play) => play.nyDay === TODAY));
});
