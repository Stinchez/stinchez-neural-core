// The STINCHEZ Traders guide, encoded as machine-checkable rules.
// Each strategy checks its indicator "setup" on a candle, then waits for the
// guide's tick-level "entry point" before it is ready to trade.

import { histColor, slope } from './indicators.js';
import { decimalDigit, lastDigit, parityEntry, tickRetest } from './digits.js';

const check = (label, pass, detail = '') => ({ label, pass: Boolean(pass), detail });
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const isGreen = (ind, i) => ind.close[i] > ind.open[i];
const isRed = (ind, i) => ind.close[i] < ind.open[i];

function bbSlender(ind, i, look = 20) {
  const w = ind.bb.width;
  let sum = 0, n = 0;
  for (let j = Math.max(0, i - look + 1); j <= i; j++) if (Number.isFinite(w[j])) { sum += w[j]; n++; }
  return n ? w[i] < sum / n : false;
}

const macdGreen = (c) => c === 'dark-green' || c === 'faded-green';
const macdRed = (c) => c === 'dark-red' || c === 'faded-red';
const runsFromMacd = (c) => (c.startsWith('dark') ? 10 : 5);

// Guide: RSI 45-55 => max 10 runs, 55-70 (or 30-45 on the odd side) => max 5 runs.
function rsiRuns(r, side) {
  if (r >= 45 && r <= 55) return 10;
  if (side === 'low' ? r >= 30 && r < 45 : r > 55 && r <= 70) return 5;
  return 0;
}

export const retestEntry = (live, side) => {
  const r = tickRetest(live.quotes, live.end);
  return check(`Tick retest ${side === 'RISE' ? '[FFF]' : '[RRR]'}`, r?.market === side, r ? `last ticks ${r.pattern}` : 'waiting for 3 ticks the other way');
};

export const parityEntryCheck = (live, side) => {
  const p = parityEntry(live.digits, live.end);
  const want = side === 'EVEN' ? '[OOE]/[OOOE]' : '[EEO]/[EEEO]';
  return check(`Digit pattern ${want}`, p?.market === side, p ? `saw ${p.pattern}` : 'waiting for pattern');
};

export const countdownEntry = (live) =>
  check('Candle countdown at 00:02', live.secondsLeft <= 2 && live.secondsLeft >= 0, `${Math.max(0, Math.floor(live.secondsLeft))}s left`);

export const digitTrigger = (live, wanted) => {
  const d = live.digits[live.end - 1];
  return check(`Entry digit ${wanted.join(' or ')}`, wanted.includes(d), `last digit ${d ?? '–'}`);
};

// ---- Matches / Differs helpers (digit-only: they read live ticks, not candles) ----

function digitFreq(live, n = 100) {
  const from = Math.max(0, live.end - n);
  const counts = new Array(10).fill(0);
  for (let k = from; k < live.end; k++) counts[live.digits[k]]++;
  const total = live.end - from || 1;
  return counts.map((c) => c / total);
}
const extreme = (live, pick) => {
  const f = digitFreq(live);
  let d = 0;
  for (let k = 1; k < 10; k++) if (pick(f[k], f[d])) d = k;
  return { d, p: f[d] };
};
const coldest = (live) => extreme(live, (a, b) => a < b);
const hottest = (live) => extreme(live, (a, b) => a > b);
// The digit that has been missing longest, and for how many ticks.
function mostAbsent(live, look = 200) {
  const gaps = new Array(10).fill(Math.min(look, live.end));
  for (let k = live.end - 1, seen = 0; k >= Math.max(0, live.end - look) && seen < 10; k--) {
    const d = live.digits[k];
    if (gaps[d] === Math.min(look, live.end)) { gaps[d] = live.end - 1 - k; seen++; }
  }
  let d = 0;
  for (let k = 1; k < 10; k++) if (gaps[k] > gaps[d]) d = k;
  return { d, gap: gaps[d] };
}
const pctText = (p) => `${(p * 100).toFixed(1)}%`;
// Replays check setups on closed candles without live ticks; digit-only
// strategies re-check their condition in entry() on every replayed tick.
const DIGIT_ONLY = check('Digit filter (checked on each tick)', true);
const MD_NOTE = 'Not in the guide: a common community idea. Digits are random — let the track record decide.';

// ---- Mean-reversion strategies inspired by digitkillertool.site ----
// The site's public page describes "probability-based … mean-reversion analysis" with
// "dynamic barriers, e.g. OVER 3 or UNDER 7" and "confidence-scaled logic"; its actual
// formulas are private. These are our own implementations of those stated ideas.
const DK_SOURCE = { url: 'https://www.digitkillertool.site/', title: 'Digit Killer Tool (public description)' };
const DK_NOTE = 'Inspired by digitkillertool.site\'s public description (mean reversion); not their private formula. The replay decides if it works.';

// z-score of how often a digit condition held in the last n ticks vs its fair rate.
function rateZ(live, n, test, fair) {
  const from = Math.max(0, live.end - n);
  const len = live.end - from;
  if (len < 30) return { rate: fair, z: 0 };
  let hit = 0;
  for (let k = from; k < live.end; k++) if (test(live.digits[k])) hit++;
  const rate = hit / len;
  return { rate, z: (rate - fair) / Math.sqrt((fair * (1 - fair)) / len) };
}
const evenZ = (live) => rateZ(live, 100, (d) => d % 2 === 0, 0.5);
// Candidate Over/Under contracts; mean reversion backs the one lagging its fair rate most.
const OU_CANDIDATES = [
  { side: 'OVER', barrier: 2, test: (d) => d > 2 },
  { side: 'OVER', barrier: 3, test: (d) => d > 3 },
  { side: 'UNDER', barrier: 6, test: (d) => d < 6 },
  { side: 'UNDER', barrier: 7, test: (d) => d < 7 },
];
function laggingOU(live) {
  let best = null;
  for (const c of OU_CANDIDATES) {
    const r = rateZ(live, 100, c.test, baseline(c.side, c.barrier));
    if (!best || r.z < best.z) best = { ...c, ...r };
  }
  return best;
}
// The digit furthest below its fair 10% over the last 200 ticks ("due" under mean reversion).
function dueDigit(live) {
  const f = digitFreq(live, 200);
  let d = 0;
  for (let k = 1; k < 10; k++) if (f[k] < f[d]) d = k;
  return { d, p: f[d] };
}

export const STRATEGIES = [
  {
    id: 'rf1', group: 'Rise / Fall', name: 'Strategy 1 · HMA + StochRSI + Aroon + A/D + MACD', bot: 'Nexus speed bot', page: 4,
    sides: ['RISE', 'FALL'],
    setup(ind, i, side) {
      const up = side === 'RISE';
      const c = histColor(ind.macd.hist, i);
      const k = ind.stochRsi.k[i], d = ind.stochRsi.d[i];
      const au = ind.aroon.up[i], ad = ind.aroon.down[i];
      const adSlope = slope(ind.ad, i, 3);
      return [
        check(`Candle ${up ? 'above' : 'below'} Hull MA`, up ? ind.close[i] > ind.hma[i] : ind.close[i] < ind.hma[i], `close ${f(ind.close[i], 3)} · HMA ${f(ind.hma[i], 3)}`),
        check(`StochRSI line ${up ? 'above' : 'below'} signal`, up ? k > d : k < d, `K ${f(k, 1)} · D ${f(d, 1)}`),
        check(`Aroon ${up ? 'up > 70 & down < 30' : 'up < 30 & down > 70'}`, up ? au > 70 && ad < 30 : au < 30 && ad > 70, `up ${f(au, 0)} · down ${f(ad, 0)}`),
        check(`A/D line ${up ? 'rising' : 'falling'}`, up ? adSlope > 0 : adSlope < 0, `3-bar change ${f(adSlope, 3)}`),
        check(`MACD histogram ${up ? 'dark green' : 'dark red'}`, c === (up ? 'dark-green' : 'dark-red'), c),
      ];
    },
    entry: retestEntry,
    runs: () => 1,
  },
  {
    id: 'rf2', group: 'Rise / Fall', name: 'Strategy 2 · Chaikin + KST + Connors RSI + MACD', bot: 'Nexus speedbot v5', page: 7,
    sides: ['RISE', 'FALL'],
    setup(ind, i, side) {
      const up = side === 'RISE';
      const c = histColor(ind.macd.hist, i);
      const kl = ind.kst.line[i], ks = ind.kst.signal[i];
      return [
        check(`Chaikin volatility ${up ? 'above' : 'below'} 0`, up ? ind.chaikin[i] > 0 : ind.chaikin[i] < 0, f(ind.chaikin[i])),
        check(`KST ${up ? 'green above red' : 'red above green'}`, up ? kl > ks : ks > kl, `KST ${f(kl)} · signal ${f(ks)}`),
        check('KST gap above 4 points', Math.abs(kl - ks) > 4, `gap ${f(Math.abs(kl - ks))}`),
        check(`Connors RSI ${up ? 'above' : 'below'} 50`, up ? ind.crsi[i] > 50 : ind.crsi[i] < 50, f(ind.crsi[i], 1)),
        check(`MACD histogram ${up ? 'dark green' : 'dark red'}`, c === (up ? 'dark-green' : 'dark-red'), c),
      ];
    },
    entry: retestEntry,
    runs: () => 1,
  },
  {
    id: 'eo1', group: 'Even / Odd', name: 'Strategy 1 · Moving average + MACD', bot: 'Nexus speed bot', page: 9,
    sides: ['ODD', 'EVEN'],
    setup(ind, i, side) {
      const odd = side === 'ODD';
      const c = histColor(ind.macd.hist, i);
      const trend = ind.close[i] - ind.close[i - 3];
      return [
        check(`Candle ${odd ? 'green' : 'red'}`, odd ? isGreen(ind, i) : isRed(ind, i), `O ${f(ind.open[i], 3)} → C ${f(ind.close[i], 3)}`),
        check(`Candle ${odd ? 'above' : 'below'} moving average`, odd ? ind.close[i] > ind.ma[i] : ind.close[i] < ind.ma[i], `MA20 ${f(ind.ma[i], 3)}`),
        check(`Candles trending ${odd ? 'up' : 'down'}`, odd ? trend > 0 : trend < 0, `3-candle change ${f(trend, 3)}`),
        check(`MACD histogram ${odd ? 'dark green' : 'dark red'}`, c === (odd ? 'dark-green' : 'dark-red'), c),
      ];
    },
    entry(live) {
      const a = decimalDigit(live.price, 2, live.pip);
      const b = decimalDigit(live.ma, 2, live.pip);
      return check('2nd decimal of price matches MA', a === b, `price …${a} · MA …${b}`);
    },
    runs: () => 1,
  },
  {
    id: 'eo2', group: 'Even / Odd', name: 'Strategy 2 · MACD + Bollinger + RSI', bot: 'Nexus speedbot v5', page: 12,
    sides: ['EVEN', 'ODD'],
    setup(ind, i, side) {
      const even = side === 'EVEN';
      const c = histColor(ind.macd.hist, i);
      const r = ind.rsi[i];
      return [
        check(`MACD histogram ${even ? 'dark green' : 'dark red'}`, c === (even ? 'dark-green' : 'dark-red'), c),
        check('Bollinger band slender', bbSlender(ind, i), `width ${f(ind.bb.width[i] * 1000, 3)}‰`),
        check(`Candle ${even ? 'above' : 'below'} middle band`, even ? ind.close[i] > ind.bb.mid[i] : ind.close[i] < ind.bb.mid[i], `mid ${f(ind.bb.mid[i], 3)}`),
        check(`RSI in ${even ? '45–70' : '30–55'} zone`, rsiRuns(r, even ? 'high' : 'low') > 0, `RSI ${f(r, 1)}`),
      ];
    },
    entry: parityEntryCheck,
    runs: (ind, i, side) => rsiRuns(ind.rsi[i], side === 'EVEN' ? 'high' : 'low') || 5,
  },
  {
    id: 'eo3', group: 'Even / Odd', name: 'Strategy 3 · Double EMA + Coppock + Mass index', bot: 'Nexus speedbot v5', page: 14,
    sides: ['ODD', 'EVEN'],
    setup(ind, i, side) {
      const odd = side === 'ODD';
      const cs = Math.sign(slope(ind.coppock, i));
      const ms = Math.sign(slope(ind.mass, i));
      return [
        check(`Candle ${odd ? 'green' : 'red'}`, odd ? isGreen(ind, i) : isRed(ind, i)),
        check('Double EMA touches the candle', ind.low[i] <= ind.dema[i] && ind.dema[i] <= ind.high[i], `DEMA ${f(ind.dema[i], 3)}`),
        check(`Coppock & Mass index face ${odd ? 'opposite' : 'same'} way`, cs !== 0 && ms !== 0 && (odd ? cs !== ms : cs === ms), `Coppock ${cs > 0 ? '↑' : '↓'} · Mass ${ms > 0 ? '↑' : '↓'}`),
      ];
    },
    entry: parityEntryCheck,
    runs: () => 5,
  },
  {
    id: 'under-high', group: 'Over / Under', name: 'Under 6/7/8/9 · Bollinger + MACD + RSI', bot: 'Titan v3 speed bot', page: 18,
    sides: ['UNDER'], barriers: [6, 7, 8, 9], barrier: 7,
    setup(ind, i) {
      const c = histColor(ind.macd.hist, i);
      return [
        check('Candle above middle band', ind.close[i] > ind.bb.mid[i], `mid ${f(ind.bb.mid[i], 3)}`),
        check('MACD histogram green', macdGreen(c), c),
        check('RSI 45–70', rsiRuns(ind.rsi[i], 'high') > 0, `RSI ${f(ind.rsi[i], 1)}`),
      ];
    },
    entry: (live, side, ind, i) => digitTrigger(live, [isGreen(ind, i) ? 8 : 7]),
    runs: (ind, i) => Math.min(runsFromMacd(histColor(ind.macd.hist, i)), rsiRuns(ind.rsi[i], 'high') || 5),
  },
  {
    id: 'over-low', group: 'Over / Under', name: 'Over 2/3/4 · Bollinger + MACD + RSI', bot: 'Titan v3 speed bot', page: 19,
    sides: ['OVER'], barriers: [2, 3, 4], barrier: 2, note: 'Guide: martingale 1.5 compulsory',
    setup(ind, i) {
      const c = histColor(ind.macd.hist, i);
      return [
        check('Candle below middle band', ind.close[i] < ind.bb.mid[i], `mid ${f(ind.bb.mid[i], 3)}`),
        check('MACD histogram green', macdGreen(c), c),
        check('RSI 45–70', rsiRuns(ind.rsi[i], 'high') > 0, `RSI ${f(ind.rsi[i], 1)}`),
      ];
    },
    entry: (live) => digitTrigger(live, [1, 2]),
    runs: (ind, i) => Math.min(runsFromMacd(histColor(ind.macd.hist, i)), rsiRuns(ind.rsi[i], 'high') || 5),
  },
  {
    id: 'under-54', group: 'Over / Under', name: 'Under 5/4 · Bollinger + MACD + RSI', bot: 'Titan v3 bot', page: 21,
    sides: ['UNDER'], barriers: [4, 5], barrier: 5,
    setup(ind, i) {
      const c = histColor(ind.macd.hist, i);
      return [
        check('Red candle falling', isRed(ind, i) && ind.close[i] < ind.close[i - 1]),
        check('Candle below middle band', ind.close[i] < ind.bb.mid[i], `mid ${f(ind.bb.mid[i], 3)}`),
        check('MACD histogram red', macdRed(c), c),
        check('RSI 30–45', ind.rsi[i] >= 30 && ind.rsi[i] <= 45, `RSI ${f(ind.rsi[i], 1)}`),
      ];
    },
    entry: (live) => digitTrigger(live, [8]),
    runs: () => 3,
  },
  {
    id: 'under-macd', group: 'Over / Under', name: 'Under 2/3/4/5 · Strategy 1 (MACD)', bot: 'Nexus speed bot v5', page: 22,
    sides: ['UNDER'], barriers: [2, 3, 4, 5], barrier: 3,
    setup(ind, i) {
      const l = ind.macd.line[i], s = ind.macd.signal[i];
      return [
        check('MACD line entering histogram from below', l < 0 && l > ind.macd.line[i - 1], `MACD ${f(l, 4)} ↑`),
        check('Signal line away from histogram', Math.abs(s) > Math.abs(l), `signal ${f(s, 4)}`),
      ];
    },
    entry: countdownEntry,
    runs: () => 1,
  },
  {
    id: 'under3-tsi', group: 'Over / Under', name: 'Under 3 · Strategy 2 (TSI)', bot: 'Nexus speed bot', page: 24,
    sides: ['UNDER'], barriers: [2, 3, 4], barrier: 3,
    setup(ind, i) {
      const t = ind.tsi[i];
      return [
        check('TSI running flat', Math.abs(t - ind.tsi[i - 3]) < 0.02, `3-bar change ${f(t - ind.tsi[i - 3], 3)}`),
        check('TSI between 0.8 and 0.9', t >= 0.8 && t <= 0.9, `TSI ${f(t, 3)}`),
        check('Candle green', isGreen(ind, i)),
      ];
    },
    entry: countdownEntry,
    runs: () => 1,
  },
  {
    id: 'over-macd', group: 'Over / Under', name: 'Over 5/6/7/8 · Strategy 1 (MACD)', bot: 'Nexus speedbot v5', page: 25,
    sides: ['OVER'], barriers: [5, 6, 7, 8], barrier: 5,
    setup(ind, i) {
      const l = ind.macd.line[i], s = ind.macd.signal[i];
      return [
        check('MACD line entering histogram from above', l > 0 && l < ind.macd.line[i - 1], `MACD ${f(l, 4)} ↓`),
        check('Signal line away from histogram', Math.abs(s) > Math.abs(l), `signal ${f(s, 4)}`),
      ];
    },
    entry: countdownEntry,
    runs: () => 1,
  },
  {
    id: 'over5-tsi', group: 'Over / Under', name: 'Over 5 · Strategy 2 (TSI)', bot: 'Nexus speedbot v5', page: 27,
    sides: ['OVER'], barriers: [4, 5, 6], barrier: 5,
    setup(ind, i) {
      const t = ind.tsi[i];
      return [
        check('TSI running flat', Math.abs(t - ind.tsi[i - 3]) < 0.02, `3-bar change ${f(t - ind.tsi[i - 3], 3)}`),
        check('TSI between 0.8 and 0.9', t >= 0.8 && t <= 0.9, `TSI ${f(t, 3)}`),
        check('Candle red', isRed(ind, i)),
      ];
    },
    entry: countdownEntry,
    runs: () => 1,
  },
  {
    id: 'md-cold', group: 'Matches / Differs', name: 'Differs · Cold digit just appeared', bot: 'Community idea', page: null,
    sides: ['DIFFERS'], note: MD_NOTE,
    setup(ind, i, side, live) {
      if (!live) return [DIGIT_ONLY];
      const c = coldest(live);
      return [check('Coldest digit ≤ 8% of last 100 ticks', c.p <= 0.08, `digit ${c.d} at ${pctText(c.p)}`)];
    },
    pickBarrier: (live) => coldest(live).d,
    entry(live) {
      const c = coldest(live);
      const d = live.digits[live.end - 1];
      return check(`Cold digit ${c.d} just appeared → differs ${c.d}`, c.p <= 0.08 && d === c.d, `last digit ${d ?? '–'}`);
    },
    runs: () => 1,
  },
  {
    id: 'md-hot', group: 'Matches / Differs', name: 'Matches · Hot digit repeating', bot: 'Community idea', page: null,
    sides: ['MATCHES'], note: MD_NOTE,
    setup(ind, i, side, live) {
      if (!live) return [DIGIT_ONLY];
      const h = hottest(live);
      return [check('Hottest digit ≥ 13% of last 100 ticks', h.p >= 0.13, `digit ${h.d} at ${pctText(h.p)}`)];
    },
    pickBarrier: (live) => hottest(live).d,
    entry(live) {
      const h = hottest(live);
      let hits = 0;
      for (let k = Math.max(0, live.end - 10); k < live.end; k++) if (live.digits[k] === h.d) hits++;
      return check(`Hot digit ${h.d} seen 2+ times in last 10 → matches ${h.d}`, h.p >= 0.13 && hits >= 2, `${hits}× in last 10`);
    },
    runs: () => 1,
  },
  {
    id: 'md-absent', group: 'Matches / Differs', name: 'Differs · Long-absent digit', bot: 'Community idea', page: null,
    sides: ['DIFFERS'], note: MD_NOTE,
    setup(ind, i, side, live) {
      if (!live) return [DIGIT_ONLY];
      const a = mostAbsent(live);
      // 40+ ticks missing happens ~14% of the time across 10 digits (0.9^40 each), so it stays a rare signal.
      return [check('A digit missing for 40+ ticks', a.gap >= 40, `digit ${a.d} absent ${a.gap} ticks`)];
    },
    pickBarrier: (live) => mostAbsent(live).d,
    entry(live) {
      const a = mostAbsent(live);
      return check(`Differs ${a.d} while it stays absent`, a.gap >= 40, `absent ${a.gap} ticks`);
    },
    runs: () => 1,
  },
  {
    id: 'dk-eo-revert', group: 'Even / Odd', name: 'DK · Even/Odd mean reversion', bot: 'Inspired · digitkillertool.site', page: null,
    sides: ['EVEN', 'ODD'], note: DK_NOTE, source: DK_SOURCE,
    // Back the side that has fallen behind 50% in the last 100 digits.
    pickSide: (live) => (evenZ(live).z < 0 ? 'EVEN' : 'ODD'),
    setup(ind, i, side, live) {
      if (!live) return [DIGIT_ONLY];
      const { rate, z } = evenZ(live);
      return [check(`${side === 'EVEN' ? 'Evens' : 'Odds'} lagging 50% by 2+ standard deviations`, Math.abs(z) >= 2, `even ${pctText(rate)} · z ${z.toFixed(2)}`)];
    },
    entry(live) {
      const { z } = evenZ(live);
      const d = live.digits[live.end - 1];
      // Fade one more digit of the over-represented side.
      const overSideTick = z < 0 ? d % 2 === 1 : d % 2 === 0;
      return check('Over-represented side just ticked again', Math.abs(z) >= 2 && overSideTick, `last digit ${d ?? '–'}`);
    },
    runs: () => 1,
    // Confidence-scaled: a bigger deviation allows more runs.
    runsLive: (live) => (Math.abs(evenZ(live).z) >= 3 ? 3 : 1),
  },
  {
    id: 'dk-ou-dynamic', group: 'Over / Under', name: 'DK · Dynamic barrier mean reversion', bot: 'Inspired · digitkillertool.site', page: null,
    sides: ['OVER', 'UNDER'], note: DK_NOTE, source: DK_SOURCE,
    pickSide: (live) => laggingOU(live).side,
    pickBarrier: (live) => laggingOU(live).barrier,
    setup(ind, i, side, live) {
      if (!live) return [DIGIT_ONLY];
      const c = laggingOU(live);
      return [check(`${c.side} ${c.barrier} lagging its fair ${pctText(baseline(c.side, c.barrier))} (z ≤ −1.5)`, c.z <= -1.5, `${pctText(c.rate)} · z ${c.z.toFixed(2)}`)];
    },
    entry(live) {
      const c = laggingOU(live);
      const d = live.digits[live.end - 1];
      return check(`Missed once more → ${c.side} ${c.barrier}`, c.z <= -1.5 && !c.test(d), `last digit ${d ?? '–'}`);
    },
    runs: () => 1,
  },
  {
    id: 'dk-match-due', group: 'Matches / Differs', name: 'DK · Matches the "due" digit', bot: 'Inspired · digitkillertool.site', page: null,
    sides: ['MATCHES'], note: `${DK_NOTE} The opposite bet of "Differs · Cold digit" — the replay shows which (if either) beats chance.`, source: DK_SOURCE,
    pickBarrier: (live) => dueDigit(live).d,
    setup(ind, i, side, live) {
      if (!live) return [DIGIT_ONLY];
      const u = dueDigit(live);
      return [check('A digit ≤ 6% of last 200 ticks ("due")', u.p <= 0.06, `digit ${u.d} at ${pctText(u.p)}`)];
    },
    entry(live) {
      const u = dueDigit(live);
      return check(`Matches due digit ${u.d}`, u.p <= 0.06, `${pctText(u.p)} of last 200`);
    },
    runs: () => 1,
  },
];

// Learned strategies join the same list in place, so every loop over
// STRATEGIES (cards, replays, scanner, brain) picks them up.
export function setLearned(list) {
  for (let k = STRATEGIES.length - 1; k >= 0; k--) if (STRATEGIES[k].learned) STRATEGIES.splice(k, 1);
  STRATEGIES.push(...list);
}

// Deriv contract for a strategy side.
export function contractFor(side, barrier) {
  switch (side) {
    case 'RISE': return { contract_type: 'CALL', duration: 5, label: 'Rise · 5 ticks' };
    case 'FALL': return { contract_type: 'PUT', duration: 5, label: 'Fall · 5 ticks' };
    case 'EVEN': return { contract_type: 'DIGITEVEN', duration: 1, label: 'Even · 1 tick' };
    case 'ODD': return { contract_type: 'DIGITODD', duration: 1, label: 'Odd · 1 tick' };
    case 'UNDER': return { contract_type: 'DIGITUNDER', barrier, duration: 1, label: `Under ${barrier} · 1 tick` };
    case 'OVER': return { contract_type: 'DIGITOVER', barrier, duration: 1, label: `Over ${barrier} · 1 tick` };
    case 'MATCHES': return { contract_type: 'DIGITMATCH', barrier, duration: 1, label: `Matches ${barrier ?? 'auto'} · 1 tick` };
    case 'DIFFERS': return { contract_type: 'DIGITDIFF', barrier, duration: 1, label: `Differs ${barrier ?? 'auto'} · 1 tick` };
    default: throw new Error(`unknown side ${side}`);
  }
}

// Probability of winning by pure chance (uniform digits, symmetric price moves).
export function baseline(side, barrier) {
  if (side === 'UNDER') return barrier / 10;
  if (side === 'OVER') return (9 - barrier) / 10;
  if (side === 'MATCHES') return 0.1;
  if (side === 'DIFFERS') return 0.9;
  return 0.5;
}

export function wins(contract, entryQuote, exitQuote, pip) {
  const d = lastDigit(exitQuote, pip);
  switch (contract.contract_type) {
    case 'CALL': return exitQuote > entryQuote;
    case 'PUT': return exitQuote < entryQuote;
    case 'DIGITEVEN': return d % 2 === 0;
    case 'DIGITODD': return d % 2 === 1;
    case 'DIGITUNDER': return d < contract.barrier;
    case 'DIGITOVER': return d > contract.barrier;
    case 'DIGITMATCH': return d === contract.barrier;
    case 'DIGITDIFF': return d !== contract.barrier;
    default: return false;
  }
}

// Evaluate a strategy at candle i, choosing the side with the strongest setup.
export function evaluate(strategy, ind, i, live, barrier = strategy.barrier) {
  let best = null;
  // Digit strategies that read live ticks may decide their side from them.
  const sides = strategy.pickSide && live ? [strategy.pickSide(live)] : strategy.sides;
  for (const side of sides) {
    const checks = strategy.setup(ind, i, side, live);
    const passed = checks.filter((c) => c.pass).length;
    if (!best || passed > best.passed) best = { side, checks, passed };
  }
  const total = best.checks.length;
  const setupOk = best.passed === total;
  const entry = live ? strategy.entry(live, best.side, ind, i) : null;
  // Matches/Differs strategies choose their digit from the live ticks.
  if (strategy.pickBarrier && live) barrier = strategy.pickBarrier(live);
  return {
    id: strategy.id,
    side: best.side,
    checks: best.checks,
    passed: best.passed,
    total,
    score: best.passed / total,
    setupOk,
    entry,
    ready: setupOk && Boolean(entry?.pass),
    runs: strategy.runsLive && live ? strategy.runsLive(live) : strategy.runs(ind, i, best.side),
    contract: contractFor(best.side, barrier),
    baseline: baseline(best.side, barrier),
  };
}
