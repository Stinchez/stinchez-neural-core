import { describe, expect, it } from 'vitest';
import { breakEven, payoutPerUnit, profitOf } from '../public/js/payouts.js';

describe('payouts', () => {
  it('values wins and losses from the quoted payout', () => {
    expect(profitOf(true, 1, 1.95)).toBe(0.95);   // Even/Odd
    expect(profitOf(true, 2, 1.09)).toBe(0.18);   // Differs pays little
    expect(profitOf(false, 2, 1.09)).toBe(-2);    // ...and loses the whole stake
    expect(profitOf(true, 1, 8.93)).toBe(7.93);   // Matches
  });

  it('gives the win rate needed to break even', () => {
    expect(breakEven(1.95)).toBeCloseTo(0.513, 3);
    expect(breakEven(1.09)).toBeCloseTo(0.917, 3);
    expect(breakEven(1.4)).toBeCloseTo(0.714, 3);
  });

  it('asks Deriv for a quote once and caches it', async () => {
    let calls = 0;
    const client = { send: async (req: Record<string, unknown>) => { calls++; expect(req.proposal).toBe(1); expect(req.barrier).toBe('3'); return { proposal: { payout: 2.18, ask_price: 2 } }; } };
    const c = { contract_type: 'DIGITDIFF', barrier: 3, duration: 1 };
    expect(await payoutPerUnit(client, 'R_10', c)).toBeCloseTo(1.09);
    expect(await payoutPerUnit(client, 'R_10', c)).toBeCloseTo(1.09);
    expect(calls).toBe(1);
  });
});
