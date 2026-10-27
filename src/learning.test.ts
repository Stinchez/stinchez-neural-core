import { describe, expect, it } from 'vitest';
import { computeAll } from '../public/js/indicators.js';
import { compileStrategy, evalCondition, specId } from '../public/js/dsl.js';
import { STRATEGIES, evaluate, setLearned } from '../public/js/strategies.js';
import { combineRecords, emptyMemory, expectedTradesUntilStreak, memoryRecord, recordPaper, streakChance } from '../public/js/learning.js';

function walk(n: number, drift = 0) {
  let s = 5;
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

const spec = {
  name: 'HMA trend follower',
  group: 'Rise / Fall',
  description: 'Buy rise above the Hull MA with RSI above 50.',
  sides: [
    { side: 'RISE', conditions: [
      { indicator: 'close', op: '>', compare_to: 'hma', value: null, value2: null, label: 'Price above HMA' },
      { indicator: 'rsi14', op: '>', compare_to: null, value: 50, value2: null, label: 'RSI above 50' },
    ] },
    { side: 'FALL', conditions: [
      { indicator: 'close', op: '<', compare_to: 'hma', value: null, value2: null, label: 'Price below HMA' },
      { indicator: 'rsi14', op: '<', compare_to: null, value: 50, value2: null, label: 'RSI below 50' },
    ] },
  ],
  entry: 'immediate',
  entry_digits: [],
  barrier: null,
  max_runs: 1,
  source_quote: 'test',
  unsupported_rules: [],
};

describe('learned strategy language', () => {
  it('evaluates conditions against indicators', () => {
    const ind = computeAll(walk(200, 0.05));
    const i = 199;
    expect(evalCondition(ind, { indicator: 'rsi14', op: 'between', value: 0, value2: 100 }, i).pass).toBe(true);
    expect(evalCondition(ind, { indicator: 'close', op: '>', compare_to: 'hma', value: null }, i).pass).toBe(ind.close[i]! > ind.hma[i]!);
    expect(evalCondition(ind, { indicator: 'adx', op: '>', value: 0 }, i).pass).toBe(true);
    expect(evalCondition(ind, { indicator: 'nope', op: '>', value: 0 }, i).pass).toBe(false);
  });

  it('compiles into a strategy the engine runs like a built-in one', () => {
    const s = compileStrategy(spec, { url: 'https://example.com/post', title: 'Example' });
    expect(s.id).toBe(specId(spec));
    expect(s.bot).toContain('example.com');
    const ind = computeAll(walk(200, 0.05));
    const live = { digits: [1, 2, 3], quotes: [1, 2, 3], end: 3, price: 1, ma: 1, pip: 2, secondsLeft: 30 };
    const r = evaluate(s, ind, 199, live);
    expect(['RISE', 'FALL']).toContain(r.side);
    expect(r.total).toBe(2);
    expect(r.entry.pass).toBe(true);
  });

  it('rejects sides that do not belong to the group', () => {
    expect(() => compileStrategy({ ...spec, group: 'Even / Odd' })).toThrow();
  });

  it('adds and removes learned strategies in the shared list', () => {
    const before = STRATEGIES.length;
    setLearned([compileStrategy(spec)]);
    expect(STRATEGIES.length).toBe(before + 1);
    setLearned([]);
    expect(STRATEGIES.length).toBe(before);
  });
});

describe('robot memory', () => {
  it('tracks wins, streaks and per-strategy records', () => {
    const mem = emptyMemory();
    for (const won of [false, false, false, true, false]) recordPaper(mem, { id: 'eo2', won, baseline: 0.5, symbol: 'R_10' });
    expect(mem.total).toBe(5);
    expect(mem.maxLossStreak).toBe(3);
    expect(mem.lossStreak).toBe(1);
    const rec = memoryRecord(mem, 'eo2')!;
    expect(rec.trades).toBe(5);
    expect(rec.winRate).toBeCloseTo(0.2);
    expect(memoryRecord(mem, 'missing')).toBeUndefined();
  });

  it('pools replay and live records', () => {
    const replay = { signals: 10, trades: 10, wins: 6, winRate: 0.6, baseline: 0.5, edge: 0.1, ci: [0.3, 0.8] };
    const live = { signals: 10, trades: 10, wins: 4, winRate: 0.4, baseline: 0.5, edge: -0.1, ci: [0.2, 0.7] };
    const c = combineRecords(replay, live);
    expect(c.trades).toBe(20);
    expect(c.winRate).toBeCloseTo(0.5);
    expect(combineRecords(replay, undefined)).toBe(replay);
  });
});

describe('loss-streak arithmetic', () => {
  it('matches known values for a coin flip', () => {
    expect(expectedTradesUntilStreak(0.5, 3)).toBeCloseTo(14);
    expect(streakChance(0.5, 3, 3)).toBeCloseTo(0.125);
    expect(streakChance(0.5, 3, 2)).toBe(0);
  });

  it('makes long sessions almost certain to contain a 3-loss streak', () => {
    expect(streakChance(0.5, 3, 100)).toBeGreaterThan(0.99);
    expect(streakChance(0.3, 3, 20)).toBeLessThan(streakChance(0.5, 3, 20));
  });
});
