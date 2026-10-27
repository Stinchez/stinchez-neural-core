import { describe, expect, it } from 'vitest';
import { MIN_STAKE, compoundStake, expectedValue, simulateGrowth, stakeLadder } from '../public/js/growth.js';

describe('small-account stake sizing', () => {
  it("is a % of balance, never below Deriv's minimum", () => {
    expect(compoundStake(10, 5)).toBe(0.5);
    expect(compoundStake(10, 2)).toBe(MIN_STAKE);
    expect(compoundStake(37.99, 5)).toBe(1.89); // rounds down, never over-stakes
  });

  it('grows the stake with the balance', () => {
    const ladder = stakeLadder(10, 20, 5);
    expect(ladder[0]).toEqual({ balance: 10, stake: 0.5 });
    expect(ladder.at(-1)).toEqual({ balance: 20, stake: 1 });
  });

  it('measures the house edge from the payout', () => {
    expect(expectedValue(0.5, 1.95)).toBeCloseTo(-0.025);
    expect(expectedValue(0.9, 1.09)).toBeCloseTo(-0.019);
    expect(expectedValue(0.55, 1.95)).toBeCloseTo(0.0725);
  });
});

describe('growth simulation', () => {
  const plan = { start: 10, target: 20, pct: 5, payout: 1.95, runs: 1500, seed: 3 };

  it('is repeatable for a seed', () => {
    expect(simulateGrowth({ ...plan, p: 0.5 })).toEqual(simulateGrowth({ ...plan, p: 0.5 }));
  });

  it('shows a real edge makes doubling far more likely than fair odds', () => {
    const fair = simulateGrowth({ ...plan, p: 0.5 });
    const edge = simulateGrowth({ ...plan, p: 0.55 });
    expect(edge.pTarget).toBeGreaterThan(fair.pTarget + 0.15);
    expect(fair.median).toBeLessThan(10); // without an edge the typical account shrinks
    expect(edge.median).toBeGreaterThan(10);
  });

  it('daily stops and small stakes keep ruin rare at fair odds', () => {
    expect(simulateGrowth({ ...plan, p: 0.5 }).pRuin).toBeLessThan(0.05);
  });
});
