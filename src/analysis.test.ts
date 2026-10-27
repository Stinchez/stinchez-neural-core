import { describe, expect, it } from 'vitest';
import { computeAll } from '../public/js/indicators.js';
import { adx, chiSquare, deepAnalysis, digitGaps, entropy, levels, resample, runsTest, transitions, trendOf } from '../public/js/analysis.js';
import { edgeFactor, think } from '../public/js/brain.js';
import { STRATEGIES, evaluate } from '../public/js/strategies.js';

function walk(n: number, drift = 0, seed = 11) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let p = 1000;
  return Array.from({ length: n }, (_, i) => {
    const open = p;
    let high = p, low = p;
    for (let t = 0; t < 20; t++) {
      p += (rand() - 0.5) * 0.4 + drift;
      high = Math.max(high, p);
      low = Math.min(low, p);
    }
    return { epoch: i * 60, open, high, low, close: p };
  });
}

describe('digit statistics', () => {
  it('scores uniform digits as random and a stuck digit as skewed', () => {
    const uniform = Array.from({ length: 1000 }, (_, i) => i % 10);
    expect(chiSquare(uniform).pValue).toBeGreaterThan(0.9);
    expect(entropy(uniform)).toBeCloseTo(1);
    const stuck = Array.from({ length: 1000 }, (_, i) => (i % 3 ? 7 : i % 10));
    expect(chiSquare(stuck).pValue).toBeLessThan(0.001);
  });

  it('detects alternating parity in the runs test', () => {
    const alt = Array.from({ length: 200 }, (_, i) => (i % 2 ? 1 : 2));
    expect(runsTest(alt).z).toBeGreaterThan(2);
  });

  it('builds a next-digit map and digit gaps', () => {
    const t = transitions([1, 2, 1, 3]);
    expect(t[1]!.total).toBe(2);
    expect(t[1]!.probs[2]).toBeCloseTo(0.5);
    expect(digitGaps([5, 1, 2, 5])[5]).toBe(0);
    expect(digitGaps([5, 1, 2, 5])[1]).toBe(2);
  });
});

describe('price structure', () => {
  it('sees an uptrend in a rising market', () => {
    const c = walk(300, 0.05);
    expect(trendOf(c).dir).toBe(1);
    const ind = computeAll(c);
    const d = adx(ind.high, ind.low, ind.close);
    expect(d.plusDI.at(-1)!).toBeGreaterThan(d.minusDI.at(-1)!);
  });

  it('resamples to a higher timeframe', () => {
    const c = walk(30);
    const r = resample(c, 60, 5);
    expect(r).toHaveLength(6);
    expect(r[0]!.open).toBe(c[0]!.open);
    expect(r[0]!.close).toBe(c[4]!.close);
    expect(r[0]!.high).toBe(Math.max(...c.slice(0, 5).map((x) => x.high)));
  });

  it('places support below and resistance above the price', () => {
    const c = walk(300);
    const price = c.at(-1)!.close;
    const l = levels(c, 0.5);
    for (const s of l.support) expect(s.price).toBeLessThan(price);
    for (const r of l.resistance) expect(r.price).toBeGreaterThan(price);
  });
});

describe('robot brain', () => {
  it('distrusts strategies proven worse than chance', () => {
    expect(edgeFactor({ trades: 100, winRate: 0.4, baseline: 0.5, ci: [0.3, 0.45] })).toBe(0.3);
    expect(edgeFactor(undefined)).toBe(0.8);
  });

  it('produces verdicts for every market type', () => {
    const candles = walk(300, 0.03);
    const ind = computeAll(candles);
    const digits = Array.from({ length: 2000 }, (_, i) => (i * 7) % 10);
    const market = { candles, ind, digits, granularity: 60 };
    const deep = deepAnalysis(market);
    const live = { digits, quotes: candles.map((c) => c.close), end: digits.length, price: ind.close.at(-1), ma: ind.ma.at(-1), pip: 2, secondsLeft: 30 };
    const results = Object.fromEntries(STRATEGIES.map((s) => [s.id, evaluate(s, ind, candles.length - 1, live)]));
    const b = think(deep, results, {});
    expect(Object.keys(b.verdicts)).toEqual(['Rise / Fall', 'Even / Odd', 'Over / Under', 'Matches / Differs']);
    for (const v of Object.values(b.verdicts)) expect(v.confidence).toBeLessThanOrEqual(1);
    expect(b.thoughts.length).toBeGreaterThan(3);
    expect(['idle', 'wait', 'go']).toContain(b.mood);
    // Every market gets a best trade, a 0..3 score tier and human reasons.
    expect(b.best).toBeTruthy();
    expect(b.marketScore).toBeGreaterThanOrEqual(0);
    expect(b.marketScore).toBeLessThanOrEqual(3);
    expect(b.strength).toBeCloseTo(b.marketScore / 3);
    expect(b.reasons[0]).toContain(b.best!.side);
    if (b.best!.ready) expect(b.marketScore).toBeGreaterThanOrEqual(2);
  });
});
