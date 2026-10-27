// The robot's long-term memory (paper-trade results per strategy) and the
// loss-streak arithmetic behind the risk guard.

import { wilson } from './backtest.js';

export function emptyMemory() {
  return { by: {}, recent: [], total: 0, wins: 0, lossStreak: 0, maxLossStreak: 0 };
}

// Record one settled paper trade. `baseline` is that contract's chance of winning.
export function recordPaper(mem, { id, won, baseline, symbol, time = Date.now() }) {
  const e = (mem.by[id] ??= { trades: 0, wins: 0, baseSum: 0 });
  e.trades++;
  e.baseSum += baseline;
  mem.total++;
  if (won) { e.wins++; mem.wins++; mem.lossStreak = 0; }
  else { mem.lossStreak++; mem.maxLossStreak = Math.max(mem.maxLossStreak, mem.lossStreak); }
  mem.recent.unshift({ id, won, symbol, time });
  mem.recent.length = Math.min(mem.recent.length, 60);
  return mem;
}

// A strategy's live record in the same shape backtest() returns.
export function memoryRecord(mem, id) {
  const e = mem.by[id];
  if (!e?.trades) return undefined;
  const baseline = e.baseSum / e.trades;
  const winRate = e.wins / e.trades;
  return { signals: e.trades, trades: e.trades, wins: e.wins, winRate, baseline, edge: winRate - baseline, ci: wilson(e.wins, e.trades) };
}

// Pool the replay and the live memory into one record (live results keep accumulating).
export function combineRecords(replay, live) {
  if (!live) return replay;
  if (!replay?.trades) return live;
  const trades = replay.trades + live.trades;
  const wins = replay.wins + live.wins;
  const baseline = (replay.baseline * replay.trades + live.baseline * live.trades) / trades;
  const winRate = wins / trades;
  return { signals: replay.signals + live.signals, trades, wins, winRate, baseline, edge: winRate - baseline, ci: wilson(wins, trades), live };
}

// Expected number of trades until the first run of n losses, with loss probability q.
export function expectedTradesUntilStreak(q, n) {
  if (q <= 0) return Infinity;
  if (q >= 1) return n;
  const qn = q ** n;
  return (1 - qn) / ((1 - q) * qn);
}

// Probability of at least one run of n losses within the next `trades` trades.
export function streakChance(q, n, trades) {
  // dp[k] = probability of currently being on a run of k losses without having hit n yet.
  let dp = new Array(n).fill(0);
  dp[0] = 1;
  let hit = 0;
  for (let t = 0; t < trades; t++) {
    const next = new Array(n).fill(0);
    for (let k = 0; k < n; k++) {
      next[0] += dp[k] * (1 - q);
      if (k + 1 === n) hit += dp[k] * q;
      else next[k + 1] += dp[k] * q;
    }
    dp = next;
  }
  return hit;
}
