// Every market Deriv offers, loaded live from active_symbols, with what each can trade.
//
// kind (from Deriv's contracts_for, checked 2026-10):
//   'digits'  – tick contracts incl. Even/Odd, Over/Under, Matches/Differs and Rise/Fall (Volatility, Jump, Daily Reset)
//   'ticks'   – Rise/Fall on ticks but no digit contracts (Step indices)
//   'minutes' – Rise/Fall only, minimum several minutes (forex, metals, stock indices, baskets)
//   'none'    – only Accumulators/Multipliers, which this desk doesn't trade (Crash/Boom, Range Break, crypto)

const KIND_BY_SUBMARKET = {
  random_index: 'digits', jump_index: 'digits', random_daily: 'digits',
  step_index: 'ticks',
  forex_basket: 'minutes', commodity_basket: 'minutes', major_pairs: 'minutes', minor_pairs: 'minutes',
  metals: 'minutes', europe_OTC: 'minutes', asia_oceania_OTC: 'minutes', americas_OTC: 'minutes',
  crash_index: 'none', range_index: 'none', non_stable_coin: 'none',
};
// Shortest Rise/Fall Deriv accepts on minute markets.
const MIN_MINUTES_BY_SUBMARKET = { metals: 5 };

const FAMILY = {
  random_index: 'Volatility', jump_index: 'Jump', random_daily: 'Daily Reset', step_index: 'Step',
  crash_index: 'Crash/Boom', range_index: 'Range Break', forex_basket: 'Baskets', commodity_basket: 'Baskets',
  major_pairs: 'Forex majors', minor_pairs: 'Forex minors', metals: 'Metals',
  europe_OTC: 'Stock indices', asia_oceania_OTC: 'Stock indices', americas_OTC: 'Stock indices', non_stable_coin: 'Crypto',
};

const vol = (symbol, name) => ({ symbol, name, family: 'Volatility', submarket: 'random_index', kind: 'digits', open: true, minMinutes: 0 });

// Used until (or if) the live list can't be loaded.
export const FALLBACK = [
  vol('R_10', 'Volatility 10'), vol('R_25', 'Volatility 25'), vol('R_50', 'Volatility 50'), vol('R_75', 'Volatility 75'), vol('R_100', 'Volatility 100'),
  vol('1HZ10V', 'Volatility 10 (1s)'), vol('1HZ15V', 'Volatility 15 (1s)'), vol('1HZ25V', 'Volatility 25 (1s)'), vol('1HZ30V', 'Volatility 30 (1s)'),
  vol('1HZ50V', 'Volatility 50 (1s)'), vol('1HZ75V', 'Volatility 75 (1s)'), vol('1HZ90V', 'Volatility 90 (1s)'), vol('1HZ100V', 'Volatility 100 (1s)'),
];

export function entryFromActiveSymbol(s) {
  const sub = s.submarket;
  return {
    symbol: s.underlying_symbol,
    name: String(s.underlying_symbol_name ?? s.underlying_symbol).replace(/ Index$/, ''),
    family: FAMILY[sub] ?? s.market,
    submarket: sub,
    kind: KIND_BY_SUBMARKET[sub] ?? 'none',
    open: s.exchange_is_open !== 0 && !s.is_trading_suspended,
    minMinutes: KIND_BY_SUBMARKET[sub] === 'minutes' ? MIN_MINUTES_BY_SUBMARKET[sub] ?? 15 : 0,
  };
}

const FAMILY_ORDER = ['Volatility', 'Jump', 'Daily Reset', 'Step', 'Crash/Boom', 'Range Break', 'Baskets', 'Forex majors', 'Forex minors', 'Metals', 'Stock indices', 'Crypto'];

export async function loadCatalog(client) {
  const { active_symbols: list } = await client.send({ active_symbols: 'brief' });
  return list
    .map(entryFromActiveSymbol)
    .sort((a, b) => (FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// Compact label for the robot orbit, radar and logs.
export function shortLabel(symbol) {
  let m;
  if ((m = /^R_(\d+)$/.exec(symbol))) return `V${m[1]}`;
  if ((m = /^1HZ(\d+)V$/.exec(symbol))) return `V${m[1]}s`;
  if ((m = /^JD(\d+)$/.exec(symbol))) return `J${m[1]}`;
  if ((m = /^stpRNG(\d*)$/.exec(symbol))) return `Step${m[1] || 1}`;
  if ((m = /^(BOOM|CRASH)(\d+)N?$/.exec(symbol))) return `${m[1][0]}${m[1].slice(1).toLowerCase()}${m[2]}`;
  return symbol.replace(/^(frx|OTC_|cry|WLD)/, '');
}

// Which strategy groups can actually be traded on a market of this kind.
export function groupTradeable(group, kind) {
  if (group === 'Rise / Fall') return kind === 'digits' || kind === 'ticks';
  return kind === 'digits';
}

// Markets the self-scan watches. Scanning 89 markets at once is heavy, so it's a choice.
export const UNIVERSES = {
  digits: { label: 'Digit markets (Volatility, Jump, Daily Reset)', test: (e) => e.kind === 'digits' },
  ticks: { label: 'All tick-tradeable synthetics (+ Step)', test: (e) => e.kind === 'digits' || e.kind === 'ticks' },
  all: { label: 'Every Deriv market (analysis for non-tick ones)', test: () => true },
};
