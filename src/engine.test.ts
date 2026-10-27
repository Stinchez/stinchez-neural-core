import { describe, expect, it } from 'vitest';
import { computeAll, ema, histColor, rsi, sma, tsi, wma } from '../public/js/indicators.js';
import { decimalDigit, lastDigit, parityEntry, tickRetest } from '../public/js/digits.js';
import { STRATEGIES, baseline, contractFor, evaluate, wins } from '../public/js/strategies.js';
import { backtest, wilson } from '../public/js/backtest.js';

// Deterministic pseudo-random walk so tests do not depend on Math.random.
function walk(n: number, seed = 7) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let p = 1000;
  const candles = [];
  for (let i = 0; i < n; i++) {
    const open = p;
    let high = p, low = p;
    for (let t = 0; t < 30; t++) {
      p += (rand() - 0.5) * 0.4;
      high = Math.max(high, p);
      low = Math.min(low, p);
    }
    candles.push({ epoch: i * 60, open, high, low, close: p });
  }
  return candles;
}

describe('indicators', () => {
  it('computes moving averages', () => {
    expect(sma([1, 2, 3, 4], 2)).toEqual([NaN, 1.5, 2.5, 3.5]);
    expect(wma([1, 2, 3], 3)[2]).toBeCloseTo((1 + 4 + 9) / 6);
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e[2]).toBeCloseTo(2);
    expect(e[4]).toBeCloseTo(4);
  });

  it('keeps RSI within 0..100 and pins a steady rise at 100', () => {
    const up = Array.from({ length: 30 }, (_, i) => i);
    expect(rsi(up, 14).at(-1)).toBe(100);
    const mixed = walk(80).map((c) => c.close);
    for (const v of rsi(mixed, 14).filter(Number.isFinite)) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('scales TSI to the -1..1 range', () => {
    const up = Array.from({ length: 80 }, (_, i) => 100 + i);
    expect(tsi(up).at(-1)).toBeCloseTo(1);
  });

  it('colours MACD histogram bars like the charts', () => {
    expect(histColor([1, 2])).toBe('dark-green');
    expect(histColor([2, 1])).toBe('faded-green');
    expect(histColor([-1, -2])).toBe('dark-red');
    expect(histColor([-2, -1])).toBe('faded-red');
  });

  it('produces finite values for every indicator after warm-up', () => {
    const ind = computeAll(walk(200));
    const i = 199;
    for (const v of [ind.hma[i], ind.ma[i], ind.stochRsi.k[i], ind.aroon.up[i], ind.macd.hist[i], ind.chaikin[i], ind.kst.signal[i], ind.crsi[i], ind.bb.width[i], ind.tsi[i], ind.dema[i], ind.coppock[i], ind.mass[i]]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('digits', () => {
  it('reads the last digit with the market pip size, keeping trailing zeros', () => {
    expect(lastDigit(1234.5, 2)).toBe(0);
    expect(lastDigit(1234.57, 2)).toBe(7);
    expect(decimalDigit(23256.4367, 2, 4)).toBe(3);
  });

  it('detects the guide parity entries', () => {
    expect(parityEntry([1, 3, 2])).toEqual({ market: 'EVEN', pattern: 'OOE' });
    expect(parityEntry([2, 4, 6, 1])).toEqual({ market: 'ODD', pattern: 'EEEO' });
    expect(parityEntry([1, 2, 3])).toBeNull();
  });

  it('detects three-tick retests', () => {
    expect(tickRetest([5, 4, 3, 2])?.market).toBe('RISE');
    expect(tickRetest([1, 2, 3, 4])?.market).toBe('FALL');
    expect(tickRetest([1, 2, 1, 2])).toBeNull();
  });
});

describe('strategies', () => {
  it('covers every market in the guide', () => {
    expect(STRATEGIES.map((s) => s.group)).toEqual(expect.arrayContaining(['Rise / Fall', 'Even / Odd', 'Over / Under', 'Matches / Differs']));
    // 12 from the guide + 3 Matches/Differs community strategies + 3 inspired by digitkillertool.site.
    expect(STRATEGIES.filter((s) => s.page)).toHaveLength(12);
    expect(STRATEGIES.filter((s) => s.id.startsWith('dk-'))).toHaveLength(3);
    expect(STRATEGIES).toHaveLength(18);
  });

  it('runs the digitkillertool-inspired mean-reversion strategies', () => {
    const ind = computeAll(walk(200));
    const byId = (id: string) => STRATEGIES.find((s) => s.id === id)!;
    // 100 digits with only 30 evens: evens lag by 4 SD; the last digit is odd (the over-represented side).
    const digits: number[] = Array.from({ length: 100 }, (_, k) => (k % 10 < 3 ? 2 : 7));
    digits[99] = 9;
    const live = { digits, quotes: digits.map((d) => 100 + d / 100), end: digits.length, price: 100, ma: 100, pip: 2, secondsLeft: 30 };

    const eo = evaluate(byId('dk-eo-revert'), ind, 199, live);
    expect(eo.side).toBe('EVEN');
    expect(eo.ready).toBe(true);
    expect(eo.runs).toBe(3); // |z| >= 3 scales up the runs

    // Only 2s and 7s/9s: "UNDER 7" hits 30% vs fair 70% (z ≈ −8.7), lagging more than UNDER 6 (z ≈ −6.1).
    const ou = evaluate(byId('dk-ou-dynamic'), ind, 199, live);
    expect(ou.contract).toMatchObject({ contract_type: 'DIGITUNDER', barrier: 7 });
    expect(ou.baseline).toBeCloseTo(0.7);

    const due = evaluate(byId('dk-match-due'), ind, 199, live);
    expect(due.contract.contract_type).toBe('DIGITMATCH');
    expect(due.baseline).toBeCloseTo(0.1);
  });

  it('supports Matches and Differs contracts with their fair odds', () => {
    expect(contractFor('MATCHES', 4)).toMatchObject({ contract_type: 'DIGITMATCH', barrier: 4, duration: 1 });
    expect(contractFor('DIFFERS', 4)).toMatchObject({ contract_type: 'DIGITDIFF', barrier: 4, duration: 1 });
    expect(baseline('MATCHES', 4)).toBeCloseTo(0.1);
    expect(baseline('DIFFERS', 4)).toBeCloseTo(0.9);
    expect(wins(contractFor('MATCHES', 4), 0, 10.04, 2)).toBe(true);
    expect(wins(contractFor('MATCHES', 4), 0, 10.05, 2)).toBe(false);
    expect(wins(contractFor('DIFFERS', 4), 0, 10.05, 2)).toBe(true);
    expect(wins(contractFor('DIFFERS', 4), 0, 10.04, 2)).toBe(false);
  });

  it('picks the Matches/Differs digit from live ticks', () => {
    const ind = computeAll(walk(200));
    // 100 ticks where 3 is rare (4%) and just appeared; 6 is hot.
    const digits = Array.from({ length: 99 }, (_, k) => [0, 1, 2, 4, 5, 6, 6, 7, 8, 9][k % 10]!);
    for (let k = 0; k < 3; k++) digits[k * 30] = 3;
    digits.push(3);
    const live = { digits, quotes: digits.map((d) => 100 + d / 100), end: digits.length, price: 100, ma: 100, pip: 2, secondsLeft: 30 };
    const cold = evaluate(STRATEGIES.find((s) => s.id === 'md-cold')!, ind, 199, live);
    expect(cold.contract).toMatchObject({ contract_type: 'DIGITDIFF', barrier: 3 });
    expect(cold.ready).toBe(true);
    const hot = evaluate(STRATEGIES.find((s) => s.id === 'md-hot')!, ind, 199, live);
    expect(hot.contract).toMatchObject({ contract_type: 'DIGITMATCH', barrier: 6 });
    expect(hot.baseline).toBeCloseTo(0.1);
  });

  it('maps sides to Deriv contracts and fair odds', () => {
    expect(contractFor('UNDER', 7)).toMatchObject({ contract_type: 'DIGITUNDER', barrier: 7, duration: 1 });
    expect(baseline('UNDER', 7)).toBeCloseTo(0.7);
    expect(baseline('OVER', 2)).toBeCloseTo(0.7);
    expect(wins(contractFor('OVER', 5), 0, 10.06, 2)).toBe(true);
    expect(wins(contractFor('EVEN', 0), 0, 10.07, 2)).toBe(false);
  });

  it('evaluates every strategy without throwing', () => {
    const candles = walk(200);
    const ind = computeAll(candles);
    const live = { digits: [1, 3, 2], quotes: [1, 2, 3], end: 3, price: 1000.12, ma: ind.ma[199], pip: 2, secondsLeft: 1.5 };
    for (const s of STRATEGIES) {
      const r = evaluate(s, ind, 199, live);
      expect(r.total).toBeGreaterThan(0);
      expect(s.sides).toContain(r.side);
      expect(r.ready).toBe(r.setupOk && r.entry.pass);
    }
  });

  it('backtests against tick history', () => {
    const candles = walk(120);
    const epochs: number[] = [];
    const quotes: number[] = [];
    for (const c of candles) for (let t = 0; t < 30; t++) { epochs.push(c.epoch + t * 2); quotes.push(Number((c.open + (c.close - c.open) * (t / 29)).toFixed(2))); }
    const market = { candles, ind: computeAll(candles), epochs, quotes, digits: quotes.map((q) => lastDigit(q, 2)), pip: 2, granularity: 60 };
    for (const s of STRATEGIES) {
      const r = backtest(s, market);
      expect(r.trades).toBeGreaterThanOrEqual(r.wins);
      expect(r.baseline).toBeGreaterThan(0);
    }
    const [lo, hi] = wilson(50, 100);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
  });
});
