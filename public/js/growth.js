// Small-account growth planning: compounding stake sizing and a Monte Carlo
// simulation of a daily plan, using real payouts and a measured win rate.

export const MIN_STAKE = 0.35; // Deriv's minimum stake (USD accounts)

const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;

// Stake that is `pct`% of the balance, never below Deriv's minimum.
export function compoundStake(balance, pct, min = MIN_STAKE) {
  return Math.max(min, floor2((balance * pct) / 100));
}

// Balance → stake milestones, e.g. for showing how stakes grow with the account.
export function stakeLadder(start, target, pct, min = MIN_STAKE) {
  const rows = [];
  let last = null;
  for (let b = start; b <= target + 1e-9; b = Math.round((b + Math.max(0.5, start * 0.1)) * 100) / 100) {
    const s = compoundStake(b, pct, min);
    if (s !== last) rows.push({ balance: Math.round(b * 100) / 100, stake: s });
    last = s;
  }
  return rows;
}

// Expected profit per 1.00 staked: p wins pay (payout - 1), losses cost 1.
export const expectedValue = (p, payout) => p * payout - 1;

// Small seeded PRNG so simulations are repeatable in tests.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simulate a daily growth plan many times.
 * Each day: trade until the daily target or daily stop is hit, `maxLossStreak`
 * losses in a row (the lock ends the day), or `tradesPerDay` trades.
 * A run ends on reaching `target` (success), or when the balance can't cover the minimum stake (ruin).
 */
export function simulateGrowth({
  start, target, pct, p, payout, days = 30, tradesPerDay = 20,
  dailyTargetPct = 10, dailyStopPct = 20, maxLossStreak = 2, runs = 2000, seed = 1, min = MIN_STAKE,
}) {
  const rand = mulberry32(seed);
  let hit = 0, ruined = 0;
  const ends = [];
  const daysToTarget = [];
  for (let r = 0; r < runs; r++) {
    let bal = start;
    let done = false;
    for (let d = 1; d <= days && !done; d++) {
      const dayStart = bal;
      let streak = 0;
      for (let k = 0; k < tradesPerDay; k++) {
        const stake = compoundStake(bal, pct, min);
        if (stake > bal + 1e-9) { ruined++; done = true; break; }
        if (rand() < p) { bal += stake * (payout - 1); streak = 0; } else { bal -= stake; streak++; }
        bal = Math.round(bal * 100) / 100;
        if (bal >= target) { hit++; daysToTarget.push(d); done = true; break; }
        if (bal - dayStart >= (dayStart * dailyTargetPct) / 100) break;
        if (dayStart - bal >= (dayStart * dailyStopPct) / 100) break;
        if (streak >= maxLossStreak) break;
      }
      if (!done && bal < min) { ruined++; done = true; }
    }
    ends.push(bal);
  }
  ends.sort((a, b) => a - b);
  const q = (f) => ends[Math.min(ends.length - 1, Math.floor(f * ends.length))];
  daysToTarget.sort((a, b) => a - b);
  return {
    pTarget: hit / runs,
    pRuin: ruined / runs,
    median: q(0.5),
    p10: q(0.1),
    p90: q(0.9),
    medianDaysToTarget: daysToTarget.length ? daysToTarget[Math.floor(daysToTarget.length / 2)] : null,
  };
}
