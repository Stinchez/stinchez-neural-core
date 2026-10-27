import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOPILOT, pickAutoTrade } from '../public/js/autopilot.js';

const market = (symbol: string, strength: number, action: Record<string, unknown> | null) => ({
  symbol, name: symbol, smooth: strength * 3,
  brain: { strength, action: action && { id: 's1', name: 'Strat', group: 'Even / Odd', side: 'ODD', contract: { contract_type: 'DIGITODD', duration: 1, label: 'Odd · 1 tick' }, ...action } },
});
const none = () => [] as string[];
const now = 1_000_000;

describe('autopilot', () => {
  it('takes the first READY signal that passes the filters', () => {
    const ranked = [market('R_10', 0.9, null), market('R_25', 0.8, {}), market('R_50', 0.95, {})];
    const r = pickAutoTrade(ranked, DEFAULT_AUTOPILOT, { now }, none);
    expect(r.trade?.symbol).toBe('R_25');
    expect(r.trade?.contract.contract_type).toBe('DIGITODD');
  });

  it('never trades while a trade is open or too soon after the last one', () => {
    const ranked = [market('R_25', 0.9, {})];
    expect(pickAutoTrade(ranked, DEFAULT_AUTOPILOT, { now, busy: true }, none).skip).toMatch(/settle/);
    expect(pickAutoTrade(ranked, DEFAULT_AUTOPILOT, { now, lastTradeAt: now - 4000 }, none).skip).toMatch(/Spacing/);
    expect(pickAutoTrade(ranked, DEFAULT_AUTOPILOT, { now, lastTradeAt: now - 11_000 }, none).trade).toBeTruthy();
  });

  it('respects strength and group filters', () => {
    const ranked = [market('R_25', 0.7, {})];
    expect(pickAutoTrade(ranked, DEFAULT_AUTOPILOT, { now }, none).trade).toBeUndefined();
    const onlyRiseFall = { ...DEFAULT_AUTOPILOT, groups: ['Rise / Fall'] };
    expect(pickAutoTrade([market('R_25', 0.9, {})], onlyRiseFall, { now }, none).trade).toBeUndefined();
  });

  it('obeys the risk pre-trade check and reports why it skipped', () => {
    const ranked = [market('R_25', 0.9, {}), market('R_50', 0.85, {})];
    const blockR25 = (_id: string, symbol: string) => (symbol === 'R_25' ? ['Stake is over 2% of your balance'] : []);
    expect(pickAutoTrade(ranked, DEFAULT_AUTOPILOT, { now }, blockR25).trade?.symbol).toBe('R_50');
    const blockAll = () => ['Loss-streak cooldown is active'];
    expect(pickAutoTrade(ranked, DEFAULT_AUTOPILOT, { now }, blockAll).skip).toMatch(/cooldown/);
  });
});
