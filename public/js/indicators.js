// Technical indicators used by the STINCHEZ Traders analysis guide.
// Every function returns an array aligned with its input; positions without
// enough history hold NaN so values can be chained safely.

const blank = (n) => new Array(n).fill(NaN);
const ok = (x) => Number.isFinite(x);

export function sma(values, period) {
  const out = blank(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let valid = true;
    for (let j = i - period + 1; j <= i; j++) {
      if (!ok(values[j])) { valid = false; break; }
      sum += values[j];
    }
    if (valid) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = blank(values.length);
  const k = 2 / (period + 1);
  let start = values.findIndex(ok);
  if (start < 0 || start + period > values.length) return out;
  let seed = 0;
  for (let i = start; i < start + period; i++) {
    if (!ok(values[i])) return out;
    seed += values[i];
  }
  let prev = seed / period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    if (!ok(values[i])) continue;
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function wma(values, period) {
  const out = blank(values.length);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let valid = true;
    for (let j = 0; j < period; j++) {
      const v = values[i - period + 1 + j];
      if (!ok(v)) { valid = false; break; }
      sum += v * (j + 1);
    }
    if (valid) out[i] = sum / denom;
  }
  return out;
}

// Wilder-style running moving average (RMA), as used inside RSI.
function rma(values, period) {
  const out = blank(values.length);
  let start = values.findIndex(ok);
  if (start < 0 || start + period > values.length) return out;
  let prev = 0;
  for (let i = start; i < start + period; i++) prev += values[i];
  prev /= period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function hma(values, period = 9) {
  const half = wma(values, Math.max(1, Math.floor(period / 2)));
  const full = wma(values, period);
  const diff = half.map((h, i) => 2 * h - full[i]);
  return wma(diff, Math.max(1, Math.round(Math.sqrt(period))));
}

export function rsi(values, period = 14) {
  const gains = blank(values.length);
  const losses = blank(values.length);
  for (let i = 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    gains[i] = Math.max(ch, 0);
    losses[i] = Math.max(-ch, 0);
  }
  const g = rma(gains, period);
  const l = rma(losses, period);
  return g.map((gv, i) => {
    if (!ok(gv) || !ok(l[i])) return NaN;
    if (l[i] === 0) return gv === 0 ? 50 : 100;
    return 100 - 100 / (1 + gv / l[i]);
  });
}

function highest(values, period, i) {
  let m = -Infinity;
  for (let j = i - period + 1; j <= i; j++) if (values[j] > m) m = values[j];
  return m;
}
function lowest(values, period, i) {
  let m = Infinity;
  for (let j = i - period + 1; j <= i; j++) if (values[j] < m) m = values[j];
  return m;
}

export function stochRsi(close, rsiLen = 14, stochLen = 14, kLen = 3, dLen = 3) {
  const r = rsi(close, rsiLen);
  const raw = blank(close.length);
  for (let i = 0; i < close.length; i++) {
    if (i < stochLen - 1) continue;
    const win = r.slice(i - stochLen + 1, i + 1);
    if (!win.every(ok)) continue;
    const hi = Math.max(...win);
    const lo = Math.min(...win);
    raw[i] = hi === lo ? 50 : ((r[i] - lo) / (hi - lo)) * 100;
  }
  const k = sma(raw, kLen);
  return { k, d: sma(k, dLen) };
}

export function aroon(high, low, period = 14) {
  const up = blank(high.length);
  const down = blank(high.length);
  for (let i = period; i < high.length; i++) {
    let hiIdx = i, loIdx = i;
    for (let j = i - period; j <= i; j++) {
      if (high[j] >= high[hiIdx]) hiIdx = j;
      if (low[j] <= low[loIdx]) loIdx = j;
    }
    up[i] = (100 * (period - (i - hiIdx))) / period;
    down[i] = (100 * (period - (i - loIdx))) / period;
  }
  return { up, down };
}

// Williams Accumulation/Distribution. Deriv synthetic indices have no volume,
// so the volume-free Williams variant stands in for the guide's A/D line.
export function williamsAD(high, low, close) {
  const out = blank(close.length);
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < close.length; i++) {
    const trh = Math.max(high[i], close[i - 1]);
    const trl = Math.min(low[i], close[i - 1]);
    if (close[i] > close[i - 1]) acc += close[i] - trl;
    else if (close[i] < close[i - 1]) acc += close[i] - trh;
    out[i] = acc;
  }
  return out;
}

export function macd(close, fast = 12, slow = 26, signal = 9) {
  const f = ema(close, fast);
  const s = ema(close, slow);
  const line = f.map((v, i) => v - s[i]);
  const sig = ema(line, signal);
  const hist = line.map((v, i) => v - sig[i]);
  return { line, signal: sig, hist };
}

// TradingView/Deriv chart histogram colouring: growing bars are "dark",
// shrinking bars are "faded".
export function histColor(hist, i = hist.length - 1) {
  const h = hist[i];
  const p = hist[i - 1];
  if (!ok(h)) return 'none';
  if (h >= 0) return !ok(p) || h >= p ? 'dark-green' : 'faded-green';
  return !ok(p) || h <= p ? 'dark-red' : 'faded-red';
}

export function chaikinVolatility(high, low, emaLen = 10, rocLen = 10) {
  const e = ema(high.map((h, i) => h - low[i]), emaLen);
  return e.map((v, i) => (i >= rocLen && ok(e[i - rocLen]) && e[i - rocLen] !== 0 ? ((v - e[i - rocLen]) / e[i - rocLen]) * 100 : NaN));
}

export function roc(values, period) {
  return values.map((v, i) => (i >= period && values[i - period] !== 0 ? ((v - values[i - period]) / values[i - period]) * 100 : NaN));
}

export function kst(close) {
  const r1 = sma(roc(close, 10), 10);
  const r2 = sma(roc(close, 15), 10);
  const r3 = sma(roc(close, 20), 10);
  const r4 = sma(roc(close, 30), 15);
  const line = r1.map((v, i) => v + 2 * r2[i] + 3 * r3[i] + 4 * r4[i]);
  return { line, signal: sma(line, 9) };
}

export function connorsRsi(close, rsiLen = 3, streakLen = 2, rankLen = 100) {
  const streak = new Array(close.length).fill(0);
  for (let i = 1; i < close.length; i++) {
    if (close[i] > close[i - 1]) streak[i] = streak[i - 1] > 0 ? streak[i - 1] + 1 : 1;
    else if (close[i] < close[i - 1]) streak[i] = streak[i - 1] < 0 ? streak[i - 1] - 1 : -1;
  }
  const r = rsi(close, rsiLen);
  const rs = rsi(streak, streakLen);
  const ch = roc(close, 1);
  const rank = blank(close.length);
  const len = Math.min(rankLen, Math.max(10, close.length - 2));
  for (let i = len; i < close.length; i++) {
    let below = 0;
    for (let j = i - len; j < i; j++) if (ch[j] < ch[i]) below++;
    rank[i] = (below / len) * 100;
  }
  return r.map((v, i) => (v + rs[i] + rank[i]) / 3);
}

export function bollinger(close, period = 20, mult = 2) {
  const mid = sma(close, period);
  const upper = blank(close.length);
  const lower = blank(close.length);
  const width = blank(close.length);
  for (let i = period - 1; i < close.length; i++) {
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (close[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sq / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    width[i] = mid[i] ? (upper[i] - lower[i]) / mid[i] : NaN;
  }
  return { mid, upper, lower, width };
}

// True Strength Index as a ratio in [-1, 1] (the scale the guide's 0.8-0.9 band uses).
export function tsi(close, long = 25, short = 13) {
  const pc = blank(close.length);
  for (let i = 1; i < close.length; i++) pc[i] = close[i] - close[i - 1];
  const num = ema(ema(pc, long), short);
  const den = ema(ema(pc.map(Math.abs), long), short);
  return num.map((v, i) => (den[i] ? v / den[i] : NaN));
}

export function dema(close, period = 9) {
  const e1 = ema(close, period);
  const e2 = ema(e1, period);
  return e1.map((v, i) => 2 * v - e2[i]);
}

export function coppock(close, wmaLen = 10, longRoc = 14, shortRoc = 11) {
  const a = roc(close, longRoc);
  const b = roc(close, shortRoc);
  return wma(a.map((v, i) => v + b[i]), wmaLen);
}

export function massIndex(high, low, emaLen = 9, sumLen = 25) {
  const e1 = ema(high.map((h, i) => h - low[i]), emaLen);
  const e2 = ema(e1, emaLen);
  const ratio = e1.map((v, i) => (e2[i] ? v / e2[i] : NaN));
  const out = blank(high.length);
  for (let i = sumLen - 1; i < high.length; i++) {
    let s = 0;
    let valid = true;
    for (let j = i - sumLen + 1; j <= i; j++) {
      if (!ok(ratio[j])) { valid = false; break; }
      s += ratio[j];
    }
    if (valid) out[i] = s;
  }
  return out;
}

export function slope(values, i = values.length - 1, lookback = 1) {
  return values[i] - values[i - lookback];
}

// Compute every indicator the guide uses for one candle series.
export function computeAll(candles) {
  const open = candles.map((c) => c.open);
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  return {
    open, high, low, close,
    hma: hma(close, 9),
    ma: sma(close, 20),
    stochRsi: stochRsi(close),
    aroon: aroon(high, low, 14),
    ad: williamsAD(high, low, close),
    macd: macd(close),
    chaikin: chaikinVolatility(high, low),
    kst: kst(close),
    crsi: connorsRsi(close),
    bb: bollinger(close),
    rsi: rsi(close, 14),
    tsi: tsi(close),
    dema: dema(close, 9),
    coppock: coppock(close),
    mass: massIndex(high, low),
  };
}
