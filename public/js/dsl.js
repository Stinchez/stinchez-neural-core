// A small rule language for strategies the robot learns from websites.
// Claude writes rules in this shape (see src/learn.ts); compileStrategy turns
// them into the same strategy objects the guide's built-in strategies use, so
// they are checked live, replayed against real ticks and scored identically.

import { adx, atr, supertrend } from './analysis.js';
import { histColor } from './indicators.js';
import { countdownEntry, digitTrigger, parityEntryCheck, retestEntry } from './strategies.js';

// Every value a learned rule may read, with how to read it at candle i.
const SERIES = {
  close: (ind) => ind.close,
  open: (ind) => ind.open,
  high: (ind) => ind.high,
  low: (ind) => ind.low,
  candle_body: (ind) => (ind._body ??= ind.close.map((c, i) => c - ind.open[i])),
  hma: (ind) => ind.hma,
  ma20: (ind) => ind.ma,
  rsi14: (ind) => ind.rsi,
  stoch_rsi_k: (ind) => ind.stochRsi.k,
  stoch_rsi_d: (ind) => ind.stochRsi.d,
  aroon_up: (ind) => ind.aroon.up,
  aroon_down: (ind) => ind.aroon.down,
  williams_ad: (ind) => ind.ad,
  macd_line: (ind) => ind.macd.line,
  macd_signal: (ind) => ind.macd.signal,
  macd_hist: (ind) => ind.macd.hist,
  chaikin_volatility: (ind) => ind.chaikin,
  kst: (ind) => ind.kst.line,
  kst_signal: (ind) => ind.kst.signal,
  connors_rsi: (ind) => ind.crsi,
  bb_upper: (ind) => ind.bb.upper,
  bb_middle: (ind) => ind.bb.mid,
  bb_lower: (ind) => ind.bb.lower,
  bb_width: (ind) => ind.bb.width,
  tsi: (ind) => ind.tsi,
  dema: (ind) => ind.dema,
  coppock: (ind) => ind.coppock,
  mass_index: (ind) => ind.mass,
  adx: (ind) => (ind._dmi ??= adx(ind.high, ind.low, ind.close)).adx,
  plus_di: (ind) => (ind._dmi ??= adx(ind.high, ind.low, ind.close)).plusDI,
  minus_di: (ind) => (ind._dmi ??= adx(ind.high, ind.low, ind.close)).minusDI,
  atr: (ind) => (ind._atr ??= atr(ind.high, ind.low, ind.close)),
  supertrend_dir: (ind) => (ind._st ??= supertrend(ind.high, ind.low, ind.close)).dir,
};

export const INDICATORS = Object.keys(SERIES);
export const OPERATORS = ['>', '<', 'between', 'rising', 'falling', 'crosses_above', 'crosses_below', 'macd_dark_green', 'macd_dark_red'];
export const ENTRIES = ['immediate', 'tick_retest_3', 'parity_pattern', 'entry_digit', 'countdown_2s'];
export const GROUP_SIDES = {
  'Rise / Fall': ['RISE', 'FALL'],
  'Even / Odd': ['EVEN', 'ODD'],
  'Over / Under': ['OVER', 'UNDER'],
  'Matches / Differs': ['MATCHES', 'DIFFERS'],
};

const f = (x) => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(2) : x.toFixed(4)) : '–');

function operand(ind, cond, i) {
  if (cond.compare_to && SERIES[cond.compare_to]) return SERIES[cond.compare_to](ind)[i];
  return cond.value;
}

// Evaluate one condition at candle i -> { pass, detail }.
export function evalCondition(ind, cond, i) {
  const series = SERIES[cond.indicator];
  if (!series) return { pass: false, detail: `unknown ${cond.indicator}` };
  const s = series(ind);
  const v = s[i];
  const prev = s[i - 1];
  const other = operand(ind, cond, i);
  const otherPrev = cond.compare_to && SERIES[cond.compare_to] ? SERIES[cond.compare_to](ind)[i - 1] : cond.value;
  switch (cond.op) {
    case '>': return { pass: v > other, detail: `${f(v)} > ${f(other)}` };
    case '<': return { pass: v < other, detail: `${f(v)} < ${f(other)}` };
    case 'between': {
      const lo = Math.min(cond.value, cond.value2), hi = Math.max(cond.value, cond.value2);
      return { pass: v >= lo && v <= hi, detail: `${f(v)} in ${f(lo)}–${f(hi)}` };
    }
    case 'rising': return { pass: v > prev, detail: `${f(prev)} → ${f(v)}` };
    case 'falling': return { pass: v < prev, detail: `${f(prev)} → ${f(v)}` };
    case 'crosses_above': return { pass: prev <= otherPrev && v > other, detail: `${f(v)} vs ${f(other)}` };
    case 'crosses_below': return { pass: prev >= otherPrev && v < other, detail: `${f(v)} vs ${f(other)}` };
    case 'macd_dark_green':
    case 'macd_dark_red': {
      const c = histColor(ind.macd.hist, i);
      return { pass: c === cond.op.replace('macd_', '').replace('_', '-'), detail: c };
    }
    default: return { pass: false, detail: `unknown op ${cond.op}` };
  }
}

function describe(cond) {
  if (cond.label) return cond.label;
  const rhs = cond.compare_to ?? cond.value;
  if (cond.op === 'between') return `${cond.indicator} between ${cond.value} and ${cond.value2}`;
  if (cond.op === 'rising' || cond.op === 'falling') return `${cond.indicator} ${cond.op}`;
  if (cond.op.startsWith('macd_')) return `MACD histogram ${cond.op.slice(5).replace('_', ' ')}`;
  return `${cond.indicator} ${cond.op.replace('_', ' ')} ${rhs}`;
}

// Short stable id from the rule content, so re-learning the same strategy doesn't duplicate it.
export function specId(spec) {
  const text = JSON.stringify([spec.name, spec.group, spec.sides, spec.entry, spec.entry_digits, spec.barrier]);
  let h = 2166136261;
  for (let k = 0; k < text.length; k++) h = Math.imul(h ^ text.charCodeAt(k), 16777619);
  return `learn-${(h >>> 0).toString(36)}`;
}

// Turn a validated spec into a strategy object (same interface as STRATEGIES entries).
export function compileStrategy(spec, source = {}) {
  const sides = GROUP_SIDES[spec.group] ? spec.sides.filter((s) => GROUP_SIDES[spec.group].includes(s.side)) : [];
  if (!sides.length) throw new Error(`"${spec.name}" has no usable sides for ${spec.group}`);
  const bySide = Object.fromEntries(sides.map((s) => [s.side, s.conditions]));
  // Over/Under barriers are 1-8 on Deriv; Matches/Differs predict any digit 0-9.
  const isMD = spec.group === 'Matches / Differs';
  const isDigitBarrier = spec.group === 'Over / Under' || isMD;
  const barrier = isMD
    ? Math.min(9, Math.max(0, Math.round(spec.barrier ?? 5)))
    : isDigitBarrier ? Math.min(8, Math.max(1, Math.round(spec.barrier ?? 5))) : undefined;
  const digits = (spec.entry_digits ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 9);
  let host = '';
  try { host = source.url ? new URL(source.url).hostname.replace(/^www\./, '') : ''; } catch { /* not a URL */ }

  return {
    id: specId(spec),
    learned: true,
    group: spec.group,
    name: spec.name,
    bot: `Learned${host ? ` · ${host}` : ''}`,
    page: null,
    note: spec.description,
    source,
    spec,
    sides: sides.map((s) => s.side),
    barriers: isDigitBarrier ? [barrier] : undefined,
    barrier,
    setup(ind, i, side) {
      const conds = bySide[side] ?? [];
      if (!conds.length) return [{ label: 'No rules for this side', pass: false, detail: '' }];
      return conds.map((c) => {
        const r = evalCondition(ind, c, i);
        return { label: describe(c), pass: Boolean(r.pass), detail: r.detail };
      });
    },
    entry(live, side, ind, i) {
      switch (spec.entry) {
        case 'tick_retest_3': return retestEntry(live, side);
        case 'parity_pattern': return parityEntryCheck(live, side);
        case 'entry_digit': return digits.length ? digitTrigger(live, digits) : { label: 'Entry digit', pass: true, detail: 'any digit' };
        case 'countdown_2s': return countdownEntry(live);
        default: return { label: 'Enter on setup', pass: true, detail: 'no extra trigger' };
      }
    },
    runs: () => Math.min(10, Math.max(1, Math.round(spec.max_runs ?? 1))),
  };
}
