import { describe, expect, it } from 'vitest';
import { FALLBACK, UNIVERSES, entryFromActiveSymbol, groupTradeable, shortLabel } from '../public/js/catalog.js';
import { filterHistory, summarize, toCsv } from '../public/js/earnings.js';

const active = (underlying_symbol: string, submarket: string, extra = {}) => ({
  underlying_symbol, underlying_symbol_name: `${underlying_symbol} Index`, submarket, market: 'x', exchange_is_open: 1, is_trading_suspended: 0, ...extra,
});

describe('market catalog', () => {
  it('classifies what each Deriv market can trade', () => {
    expect(entryFromActiveSymbol(active('R_100', 'random_index')).kind).toBe('digits');
    expect(entryFromActiveSymbol(active('JD10', 'jump_index')).kind).toBe('digits');
    expect(entryFromActiveSymbol(active('stpRNG', 'step_index')).kind).toBe('ticks');
    const fx = entryFromActiveSymbol(active('frxEURUSD', 'major_pairs'));
    expect(fx.kind).toBe('minutes');
    expect(fx.minMinutes).toBe(15);
    expect(entryFromActiveSymbol(active('frxXAUUSD', 'metals')).minMinutes).toBe(5);
    expect(entryFromActiveSymbol(active('BOOM1000', 'crash_index')).kind).toBe('none');
    expect(entryFromActiveSymbol(active('cryBTCUSD', 'non_stable_coin')).kind).toBe('none');
    expect(entryFromActiveSymbol(active('OTC_SSMI', 'europe_OTC', { exchange_is_open: 0 })).open).toBe(false);
    expect(entryFromActiveSymbol(active('R_10', 'random_index')).name).toBe('R_10');
  });

  it('only allows strategy groups a market offers', () => {
    expect(groupTradeable('Even / Odd', 'digits')).toBe(true);
    expect(groupTradeable('Rise / Fall', 'ticks')).toBe(true);
    expect(groupTradeable('Over / Under', 'ticks')).toBe(false);
    expect(groupTradeable('Rise / Fall', 'minutes')).toBe(false);
    expect(groupTradeable('Matches / Differs', 'none')).toBe(false);
  });

  it('builds short labels and scan universes', () => {
    expect(shortLabel('R_75')).toBe('V75');
    expect(shortLabel('1HZ15V')).toBe('V15s');
    expect(shortLabel('JD25')).toBe('J25');
    expect(shortLabel('stpRNG3')).toBe('Step3');
    expect(shortLabel('frxEURUSD')).toBe('EURUSD');
    expect(shortLabel('CRASH500')).toBe('Crash500');
    expect(FALLBACK.every((e) => UNIVERSES.digits.test(e))).toBe(true);
    expect(UNIVERSES.ticks.test(entryFromActiveSymbol(active('stpRNG', 'step_index')))).toBe(true);
    expect(UNIVERSES.digits.test(entryFromActiveSymbol(active('frxEURUSD', 'major_pairs')))).toBe(false);
  });
});

describe('earnings', () => {
  const trade = (t: number, symbol: string, profit: number, extra = {}) => ({
    t, symbol, stake: 1, profit, won: profit > 0, auto: false, contract: 'Even · 1 tick', type: 'DIGITEVEN',
    strategyId: 'eo2', strategyName: 'Strategy 2', group: 'Even / Odd', acct: 'demo', accountId: 'D1', currency: 'USD', ...extra,
  });
  const history = [
    trade(1000, 'R_10', 0.95), trade(2000, 'R_10', -1), trade(3000, 'R_25', -1, { auto: true }),
    trade(4000, 'R_25', 1.9, { auto: true }), trade(5000, 'R_50', 5, { acct: 'real' }),
  ];

  it('filters by account and time', () => {
    expect(filterHistory(history, { acct: 'demo' })).toHaveLength(4);
    expect(filterHistory(history, { acct: 'all', since: 3000 })).toHaveLength(3);
  });

  it('summarises profit, win rate, drawdown and breakdowns', () => {
    const s = summarize(filterHistory(history, { acct: 'demo' }));
    expect(s.net).toBeCloseTo(0.85);
    expect(s.winRate).toBeCloseTo(0.5);
    expect(s.maxDrawdown).toBeCloseTo(2); // +0.95 peak, then down to -1.05
    expect(s.curve.at(-1)!.equity).toBeCloseTo(0.85);
    expect(s.byMarket.map((b) => b.key)).toEqual(['R_25', 'R_10']); // R_25 +0.90 earns more than R_10 −0.05
    expect(s.autoVsManual.find((b) => b.key === 'auto')!.trades).toBe(2);
    expect(s.byType[0]!.label).toBe('Even');
  });

  it('exports CSV', () => {
    const csv = toCsv(history.slice(0, 1));
    expect(csv.split('\n')[0]).toContain('profit');
    expect(csv).toContain('R_10');
  });
});
