// Deeper market analysis beyond the guide: digit randomness tests, digit
// transitions, trend strength, volatility regime, support/resistance and
// multi-timeframe trend.

import { ema } from './indicators.js';

const blank = (n) => new Array(n).fill(NaN);

// ---------- digit statistics ----------

function lnGamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = z, t = z + 5.5;
  t -= (z + 0.5) * Math.log(t);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -t + Math.log((2.5066282746310005 * ser) / z);
}

// Regularised lower incomplete gamma P(s, x): series for small x, continued
// fraction for large x (Numerical Recipes gser/gcf).
function gammaP(s, x) {
  if (x <= 0) return 0;
  const front = Math.exp(-x + s * Math.log(x) - lnGamma(s));
  if (x < s + 1) {
    let sum = 1 / s, term = 1 / s;
    for (let n = 1; n < 500; n++) {
      term *= x / (s + n);
      sum += term;
      if (term < sum * 1e-14) break;
    }
    return Math.min(1, sum * front);
  }
  const tiny = 1e-300;
  let b = x + 1 - s, c = 1 / tiny, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.max(0, 1 - front * h);
}

// Chi-square goodness of fit against uniform digits; low p means a real skew.
export function chiSquare(digits) {
  const n = digits.length;
  const counts = new Array(10).fill(0);
  for (const d of digits) counts[d]++;
  const e = n / 10;
  const stat = e ? counts.reduce((s, o) => s + (o - e) ** 2 / e, 0) : 0;
  return { stat, pValue: n ? 1 - gammaP(9 / 2, stat / 2) : 1 };
}

// Shannon entropy of the digit distribution, 1 = perfectly uniform.
export function entropy(digits) {
  const counts = new Array(10).fill(0);
  for (const d of digits) counts[d]++;
  let h = 0;
  for (const c of counts) if (c) { const p = c / digits.length; h -= p * Math.log2(p); }
  return digits.length ? h / Math.log2(10) : 1;
}

// Wald–Wolfowitz runs test on even/odd: z < -2 streaky, z > 2 alternating.
export function runsTest(digits) {
  const n = digits.length;
  if (n < 20) return { runs: 0, expected: 0, z: 0 };
  let n1 = 0, runs = 1;
  for (let i = 0; i < n; i++) {
    if (digits[i] % 2 === 0) n1++;
    if (i && digits[i] % 2 !== digits[i - 1] % 2) runs++;
  }
  const n2 = n - n1;
  const expected = (2 * n1 * n2) / n + 1;
  const variance = (2 * n1 * n2 * (2 * n1 * n2 - n)) / (n * n * (n - 1));
  return { runs, expected, z: variance > 0 ? (runs - expected) / Math.sqrt(variance) : 0 };
}

// z-score of the even share in the last n digits.
export function parityZ(digits, n = 100) {
  const s = digits.slice(-n);
  const even = s.filter((d) => d % 2 === 0).length;
  return s.length ? (even - s.length / 2) / Math.sqrt(s.length / 4) : 0;
}

// P(next digit | current digit) with row sample sizes.
export function transitions(digits) {
  const counts = Array.from({ length: 10 }, () => new Array(10).fill(0));
  for (let i = 1; i < digits.length; i++) counts[digits[i - 1]][digits[i]]++;
  return counts.map((row) => {
    const total = row.reduce((a, b) => a + b, 0);
    return { total, probs: row.map((c) => (total ? c / total : 0)) };
  });
}

// Ticks since each digit last appeared.
export function digitGaps(digits) {
  const gaps = new Array(10).fill(digits.length);
  for (let i = digits.length - 1, seen = 0; i >= 0 && seen < 10; i--) {
    const d = digits[i];
    if (gaps[d] === digits.length) { gaps[d] = digits.length - 1 - i; seen++; }
  }
  return gaps;
}

// ---------- price structure ----------

function rma(values, period) {
  const out = blank(values.length);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) continue;
    if (!Number.isFinite(prev)) {
      if (i < period) continue;
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      prev = s / period;
    } else prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

function trueRange(high, low, close) {
  return high.map((h, i) => (i ? Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1])) : h - low[i]));
}

export function atr(high, low, close, period = 14) {
  return rma(trueRange(high, low, close), period);
}

// Average Directional Index: trend strength (>25 trending, <20 ranging).
export function adx(high, low, close, period = 14) {
  const n = high.length;
  const plus = blank(n), minus = blank(n);
  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1];
    const down = low[i - 1] - low[i];
    plus[i] = up > down && up > 0 ? up : 0;
    minus[i] = down > up && down > 0 ? down : 0;
  }
  const tr = rma(trueRange(high, low, close).map((v, i) => (i ? v : NaN)), period);
  const p = rma(plus, period), m = rma(minus, period);
  const plusDI = p.map((v, i) => (100 * v) / tr[i]);
  const minusDI = m.map((v, i) => (100 * v) / tr[i]);
  const dx = plusDI.map((v, i) => (v + minusDI[i] ? (100 * Math.abs(v - minusDI[i])) / (v + minusDI[i]) : 0));
  return { adx: rma(dx, period), plusDI, minusDI };
}

// Supertrend: dir 1 = up, -1 = down.
export function supertrend(high, low, close, period = 10, mult = 3) {
  const a = atr(high, low, close, period);
  const n = close.length;
  const line = blank(n), dir = new Array(n).fill(0);
  let upper = NaN, lower = NaN, d = 1;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(a[i])) continue;
    const mid = (high[i] + low[i]) / 2;
    const bu = mid + mult * a[i], bl = mid - mult * a[i];
    upper = !Number.isFinite(upper) || bu < upper || close[i - 1] > upper ? bu : upper;
    lower = !Number.isFinite(lower) || bl > lower || close[i - 1] < lower ? bl : lower;
    if (close[i] > upper) d = 1;
    else if (close[i] < lower) d = -1;
    dir[i] = d;
    line[i] = d === 1 ? lower : upper;
  }
  return { line, dir };
}

// Percentile of the latest value within the last `look` values.
export function percentile(values, look = 200) {
  const s = values.slice(-look).filter(Number.isFinite);
  const last = s[s.length - 1];
  return s.length ? s.filter((v) => v <= last).length / s.length : NaN;
}

// Support/resistance from clustered swing highs and lows.
export function levels(candles, atrValue, look = 240, max = 3) {
  const c = candles.slice(-look);
  const swings = [];
  for (let i = 2; i < c.length - 2; i++) {
    const h = c[i].high, l = c[i].low;
    if (h >= c[i - 1].high && h >= c[i - 2].high && h >= c[i + 1].high && h >= c[i + 2].high) swings.push(h);
    if (l <= c[i - 1].low && l <= c[i - 2].low && l <= c[i + 1].low && l <= c[i + 2].low) swings.push(l);
  }
  const tol = (atrValue || 0) * 0.6 || 1e-9;
  const clusters = [];
  for (const p of swings.sort((a, b) => a - b)) {
    const last = clusters[clusters.length - 1];
    if (last && p - last.price <= tol) {
      last.sum += p;
      last.touches++;
      last.price = last.sum / last.touches;
    } else clusters.push({ price: p, sum: p, touches: 1 });
  }
  const price = c[c.length - 1]?.close ?? 0;
  const strong = clusters.filter((k) => k.touches >= 2);
  const pick = (arr) => arr.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price)).slice(0, max).map(({ price: p, touches }) => ({ price: p, touches }));
  return {
    support: pick(strong.filter((k) => k.price < price)),
    resistance: pick(strong.filter((k) => k.price > price)),
  };
}

// Merge candles into a higher timeframe (factor x the base granularity).
export function resample(candles, granularity, factor) {
  const size = granularity * factor;
  const out = [];
  for (const c of candles) {
    const start = c.epoch - (c.epoch % size);
    const last = out[out.length - 1];
    if (last && last.epoch === start) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
    } else out.push({ epoch: start, open: c.open, high: c.high, low: c.low, close: c.close });
  }
  return out;
}

// Trend of a candle series: +1 up, -1 down, 0 flat, from EMA alignment and slope.
export function trendOf(candles) {
  const close = candles.map((c) => c.close);
  const fast = ema(close, 9), slow = ema(close, 21);
  const i = close.length - 1;
  if (!Number.isFinite(slow[i]) || !Number.isFinite(slow[i - 2])) return { dir: 0, label: 'warming up' };
  const up = close[i] > fast[i] && fast[i] > slow[i] && slow[i] > slow[i - 2];
  const down = close[i] < fast[i] && fast[i] < slow[i] && slow[i] < slow[i - 2];
  return { dir: up ? 1 : down ? -1 : 0, label: up ? 'up' : down ? 'down' : 'sideways' };
}

// Everything the deep-analysis panel and the robot need for one market.
export function deepAnalysis(market) {
  const { candles, ind, digits, granularity } = market;
  const i = candles.length - 1;
  const a = atr(ind.high, ind.low, ind.close);
  const dx = adx(ind.high, ind.low, ind.close);
  const st = supertrend(ind.high, ind.low, ind.close);
  const recent = digits.slice(-1000);
  return {
    chi: chiSquare(recent),
    entropy: entropy(recent),
    runs: runsTest(digits.slice(-300)),
    parityZ: parityZ(digits, 100),
    transitions: transitions(recent),
    gaps: digitGaps(digits),
    atr: a[i],
    atrPct: percentile(a),
    adx: dx.adx[i],
    plusDI: dx.plusDI[i],
    minusDI: dx.minusDI[i],
    supertrend: { level: st.line[i], dir: st.dir[i], line: st.line },
    levels: levels(candles, a[i]),
    mtf: [
      { tf: `${granularity / 60}m`, ...trendOf(candles) },
      { tf: `${(granularity * 5) / 60}m`, ...trendOf(resample(candles, granularity, 5)) },
      { tf: `${(granularity * 15) / 60}m`, ...trendOf(resample(candles, granularity, 15)) },
    ],
  };
}
