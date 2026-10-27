// A live market: candle history + tick stream for one Deriv symbol, with
// candles rolled forward locally from each tick and indicators recomputed.

import { computeAll } from './indicators.js';
import { lastDigit } from './digits.js';
import { FALLBACK } from './catalog.js';

// All known markets. Starts with the Volatility indices and is replaced in place
// by Deriv's live list (catalog.js) once it loads, so every importer sees it.
export const SYMBOLS = [...FALLBACK];

export function setSymbols(list) {
  SYMBOLS.splice(0, SYMBOLS.length, ...list);
}

export class Market extends EventTarget {
  constructor(client, symbol, granularity, { candleCount = 600, tickCount = 5000 } = {}) {
    super();
    Object.assign(this, { client, symbol, granularity, candleCount, tickCount });
    this.candles = [];
    this.epochs = [];
    this.quotes = [];
    this.digits = [];
    this.pip = 2;
    this.ind = null;
    this.clockOffset = 0;
    this.loaded = false;
  }

  async start() {
    const hist = await this.client.send({
      ticks_history: this.symbol, style: 'candles', granularity: this.granularity, count: this.candleCount, end: 'latest',
    });
    this.candles = hist.candles.map((c) => ({ epoch: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
    this.sub = await this.client.subscribe(
      { ticks_history: this.symbol, style: 'ticks', count: this.tickCount, end: 'latest' },
      (msg) => (msg.history ? this.onHistory(msg) : msg.tick && this.onTick(msg.tick)),
      (err) => this.dispatchEvent(new CustomEvent('error', { detail: err })),
    );
    return this;
  }

  stop() {
    this.sub?.forget();
  }

  onHistory(msg) {
    this.pip = msg.pip_size ?? this.pip;
    this.epochs = msg.history.times.slice();
    this.quotes = msg.history.prices.map(Number);
    this.digits = this.quotes.map((q) => lastDigit(q, this.pip));
    for (let i = 0; i < this.epochs.length; i++) this.roll(this.epochs[i], this.quotes[i], false);
    this.recompute();
    this.loaded = true;
    this.dispatchEvent(new Event('update'));
  }

  onTick(tick) {
    this.pip = tick.pip_size ?? this.pip;
    const q = Number(tick.quote);
    this.epochs.push(tick.epoch);
    this.quotes.push(q);
    this.digits.push(lastDigit(q, this.pip));
    const max = this.tickCount + 500;
    if (this.epochs.length > max) {
      const cut = this.epochs.length - this.tickCount;
      this.epochs.splice(0, cut);
      this.quotes.splice(0, cut);
      this.digits.splice(0, cut);
    }
    this.clockOffset = tick.epoch - Date.now() / 1000;
    const newCandle = this.roll(tick.epoch, q, true);
    this.recompute();
    this.dispatchEvent(new CustomEvent('update', { detail: { tick: true, newCandle } }));
  }

  // Fold a tick into the candle series. Returns true when it opened a new candle.
  roll(epoch, quote, trim) {
    const start = epoch - (epoch % this.granularity);
    const last = this.candles[this.candles.length - 1];
    if (last && start < last.epoch) return false;
    if (last && start === last.epoch) {
      last.high = Math.max(last.high, quote);
      last.low = Math.min(last.low, quote);
      last.close = quote;
      return false;
    }
    this.candles.push({ epoch: start, open: last ? last.close : quote, high: quote, low: quote, close: quote });
    if (trim && this.candles.length > this.candleCount) this.candles.shift();
    return true;
  }

  recompute() {
    this.ind = computeAll(this.candles);
  }

  get serverNow() {
    return Date.now() / 1000 + this.clockOffset;
  }

  get secondsLeft() {
    const last = this.candles[this.candles.length - 1];
    return last ? last.epoch + this.granularity - this.serverNow : NaN;
  }

  // Live entry context consumed by strategy.entry().
  live() {
    const i = this.candles.length - 1;
    return {
      digits: this.digits,
      quotes: this.quotes,
      end: this.quotes.length,
      price: this.quotes[this.quotes.length - 1],
      ma: this.ind?.ma[i],
      pip: this.pip,
      secondsLeft: this.secondsLeft,
    };
  }
}
