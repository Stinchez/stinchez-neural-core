import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK, applyOutcome, newSession, nextStake, preTradeCheck, stopLossAmount, worstCase } from '../public/js/risk.js';

const flat = { ...DEFAULT_RISK };
const mart = { ...DEFAULT_RISK, recovery: 'martingale' };

describe('2-loss limits', () => {
  it('defaults to a 2-loss streak lock and a 2-step recovery cap', () => {
    expect(DEFAULT_RISK.maxStreak).toBe(2);
    expect(DEFAULT_RISK.maxSteps).toBe(2);
  });

  it('caps the worst case at two losses', () => {
    expect(worstCase(1, flat)).toBe(2);          // 1 + 1
    expect(worstCase(1, mart)).toBe(2.5);        // 1 + 1.5 (the guide's martingale)
    expect(stopLossAmount(1, mart)).toBe(2.5);   // auto stop-loss = one worst-case cycle
    expect(stopLossAmount(1, { ...mart, stopLoss: 4 })).toBe(4);
  });

  it('raises the stake once, then resets after the second loss', () => {
    const s = newSession();
    expect(nextStake(1, mart, s)).toBe(1);
    applyOutcome(s, mart, 1, { won: false, profit: -1 });
    expect(nextStake(1, mart, s)).toBe(1.5);
    const events = applyOutcome(s, mart, 1, { won: false, profit: -1.5 });
    expect(events).toContain('cycle-capped');
    expect(nextStake(1, mart, s)).toBe(1); // no third, bigger attempt
  });

  it('resets the cycle on a win', () => {
    const s = newSession();
    applyOutcome(s, mart, 1, { won: false, profit: -1 });
    applyOutcome(s, mart, 1, { won: true, profit: 1.4 });
    expect(s.step).toBe(0);
    expect(nextStake(1, mart, s)).toBe(1);
  });
});

describe('session limits', () => {
  it('ends the session at the stop-loss', () => {
    const s = newSession();
    applyOutcome(s, flat, 1, { won: false, profit: -1 });
    expect(s.ended).toBeNull();
    const events = applyOutcome(s, flat, 1, { won: false, profit: -1 });
    expect(events).toContain('stop-loss');
    expect(s.ended).toMatch(/stop-loss/);
  });

  it('ends the session at take-profit and at max trades', () => {
    const tp = newSession();
    expect(applyOutcome(tp, { ...flat, takeProfit: 1.5 }, 1, { won: true, profit: 1.9 })).toContain('take-profit');
    const mt = newSession();
    const few = { ...flat, maxTrades: 2, stopLoss: 100 };
    applyOutcome(mt, few, 1, { won: true, profit: 0.9 });
    expect(applyOutcome(mt, few, 1, { won: false, profit: -1 })).toContain('max-trades');
  });
});

describe('pre-trade check', () => {
  const ok = { stake: 1, base: 1, settings: flat, session: newSession(), balance: 1000, verdict: 'unproven', locked: false };

  it('allows a normal trade', () => {
    expect(preTradeCheck(ok)).toEqual([]);
  });

  it('blocks a trade that could break the stop-loss', () => {
    const s = newSession();
    s.pnl = -1.5;
    expect(preTradeCheck({ ...ok, session: s }).join()).toMatch(/stop-loss/);
  });

  it('blocks oversized stakes, rejected strategies, locks and ended sessions', () => {
    expect(preTradeCheck({ ...ok, stake: 50, settings: { ...flat, stopLoss: 1000 } }).join()).toMatch(/% of your balance/);
    expect(preTradeCheck({ ...ok, verdict: 'rejected' }).join()).toMatch(/worse than chance/);
    expect(preTradeCheck({ ...ok, locked: true }).join()).toMatch(/cooldown/);
    expect(preTradeCheck({ ...ok, session: { ...newSession(), ended: 'stop-loss hit' } }).join()).toMatch(/Session ended/);
  });

  it("blocks stakes under Deriv's minimum and stakes the balance can't cover", () => {
    expect(preTradeCheck({ ...ok, stake: 0.2 }).join()).toMatch(/minimum of 0.35/);
    expect(preTradeCheck({ ...ok, stake: 1, balance: 0.8, settings: { ...flat, maxStakePct: 100 } }).join()).toMatch(/Not enough balance/);
  });

  it('explains how to fix a % cap that is below the minimum stake on a small account', () => {
    const r = preTradeCheck({ ...ok, stake: 0.35, balance: 10 }).join();
    expect(r).toMatch(/raise "Max stake" to at least 3.5%/);
  });

  it('strict entries only allow proven strategies', () => {
    const strict = { ...ok, settings: { ...flat, strict: true } };
    expect(preTradeCheck(strict).join()).toMatch(/Strict entries/);
    expect(preTradeCheck({ ...strict, verdict: 'proven' })).toEqual([]);
  });
});
