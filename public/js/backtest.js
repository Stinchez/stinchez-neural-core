// Replays the recent tick history to measure how each strategy would have done.
// The setup is checked on a closed candle (no look-ahead); the entry is then
// searched in the ticks of the following candle, exactly as a trader would.

import { baseline, contractFor, evaluate, wins } from './strategies.js';

function firstIndexAtOrAfter(epochs, t) {
  let lo = 0, hi = epochs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (epochs[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Wilson score interval for a win rate.
export function wilson(winsCount, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = winsCount / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}

export function backtest(strategy, market, barrier = strategy.barrier) {
  const { candles, ind, epochs, quotes, digits, pip, granularity } = market;
  let signals = 0, trades = 0, won = 0, baseSum = 0;
  let base = null;
  const startEpoch = epochs[0] ?? Infinity;
  for (let i = 40; i < candles.length - 1; i++) {
    const next = candles[i + 1];
    if (next.epoch < startEpoch) continue;
    const res = evaluate(strategy, ind, i, null, barrier);
    base ??= res.baseline;
    if (!res.setupOk) continue;
    const from = firstIndexAtOrAfter(epochs, next.epoch);
    const to = firstIndexAtOrAfter(epochs, next.epoch + granularity);
    if (to >= epochs.length) continue; // candle not finished yet
    let entryIdx = -1;
    let entryLive = null;
    for (let k = Math.max(from, 1); k < to; k++) {
      const live = { digits, quotes, end: k + 1, price: quotes[k], ma: ind.ma[i], pip, secondsLeft: next.epoch + granularity - epochs[k] };
      if (strategy.entry(live, res.side, ind, i).pass) { entryIdx = k; entryLive = live; break; }
    }
    if (entryIdx < 0) continue;
    signals++;
    // Digit strategies choose side, digit and confidence-scaled runs from the ticks seen at entry.
    const side = strategy.pickSide ? strategy.pickSide(entryLive) : res.side;
    const tradeBarrier = strategy.pickBarrier ? strategy.pickBarrier(entryLive) : barrier;
    const contract = contractFor(side, tradeBarrier);
    const runs = strategy.runsLive ? strategy.runsLive(entryLive) : res.runs;
    const dur = contract.duration;
    for (let r = 0; r < runs; r++) {
      const entry = entryIdx + r;
      const exit = entry + dur;
      if (exit >= quotes.length) break;
      trades++;
      baseSum += baseline(side, tradeBarrier);
      if (wins(contract, quotes[entry], quotes[exit], pip)) won++;
    }
  }
  // With dynamic contracts the fair odds vary per trade, so compare against their average.
  if (trades) base = baseSum / trades;
  base ??= evaluate(strategy, ind, ind.close.length - 1, null, barrier).baseline;
  const winRate = trades ? won / trades : NaN;
  return { signals, trades, wins: won, winRate, baseline: base, edge: winRate - base, ci: wilson(won, trades) };
}
