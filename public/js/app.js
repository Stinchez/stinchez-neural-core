import { DerivClient, listAccounts, listAccountsOAuth, oauthLogout, oauthSession, tradingClient, tradingClientOAuth } from './deriv.js';
import { Market, SYMBOLS, setSymbols } from './market.js';
import { UNIVERSES, groupTradeable, loadCatalog, shortLabel } from './catalog.js';
import { STRATEGIES, evaluate } from './strategies.js';
import { backtest } from './backtest.js';
import { digitStats, parityEntry, parityStreak } from './digits.js';
import { histColor } from './indicators.js';
import { deepAnalysis } from './analysis.js';
import { think } from './brain.js';
import { RobotMind } from './robot.js';
import { Globe } from './globe.js';
import { Tunnel } from './tunnel.js';
import { compileStrategy } from './dsl.js';
import { setLearned, wins } from './strategies.js';
import { combineRecords, emptyMemory, expectedTradesUntilStreak, memoryRecord, recordPaper, streakChance } from './learning.js';
import { edgeFactor } from './brain.js';
import { AUTOPILOT_GROUPS, DEFAULT_AUTOPILOT, pickAutoTrade } from './autopilot.js';
import { filterHistory, summarize, toCsv } from './earnings.js';
import { payoutPerUnit, profitOf } from './payouts.js';
import { MIN_STAKE, compoundStake, expectedValue, simulateGrowth, stakeLadder } from './growth.js';
import { DEFAULT_RISK, applyOutcome, newSession, nextStake, preTradeCheck, stopLossAmount, worstCase } from './risk.js';

const $ = (id) => document.getElementById(id);
const pct = (x, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '–');
const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const store = {
  get(key, fallback) {
    try { return localStorage.getItem(`stz.${key}`) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`stz.${key}`, value); } catch { /* storage unavailable */ }
  },
};

const state = {
  symbol: store.get('symbol', 'R_100'),
  granularity: Number(store.get('granularity', '60')),
  group: 'all',
  barriers: Object.fromEntries(STRATEGIES.map((s) => [s.id, s.barrier])),
  results: {},
  records: {},
  wasReady: new Set(),
  account: null, // { account_id, currency, account_type, ... }
  accounts: [],
  auth: null, // { kind: 'oauth' } | { kind: 'pat', token, appId } — a PAT stays in memory only
  trader: null, // trading socket for the linked account
  market: null,
  scanner: new Map(),
  scanning: false,
  scanScores: new Map(), // symbol -> { score, ready, brain }
  scanRecords: new Map(), // symbol -> { epoch, records }
  deep: null,
  brain: null,
  lastMind: 0,
  thoughts: [], // { time, text, key }
  autoRotate: false,
  rotateTimer: null,
  sweeps: 0,
  bestSymbol: null, // the self-scan's current pick
  bestSince: null,
  learned: loadJson('learned', []), // [{ spec, source, learnedAt, enabled, unsupported }]
  memory: loadJson('memory', null) ?? emptyMemory(),
  paperOpen: new Map(), // `${symbol}|${id}` -> open paper trade
  paperWasReady: new Set(),
  risk: loadJson('risk', null) ?? { lossStreak: 0, lockedUntil: 0, cold: {} },
  session: loadJson('session', null) ?? newSession(),
  history: loadJson('history', []), // settled paper/demo/real trades, for the Earnings dashboard
  paperSession: loadJson('paperSession', null) ?? newSession(),
  paperRisk: loadJson('paperRisk', null) ?? { lossStreak: 0, lockedUntil: 0, cold: {} },
  autopilot: { on: false, mode: null, busy: false, lastTradeAt: 0, status: '', paperOpen: null, log: [], run: { trades: 0, wins: 0, losses: 0, pnl: 0 } },
  balance: 0, // latest account balance, for the % of balance stake cap
};

function loadJson(key, fallback) {
  try { return JSON.parse(store.get(key, 'null')) ?? fallback; } catch { return fallback; }
}
function saveJson(key, value) {
  store.set(key, JSON.stringify(value));
}

const shortName = shortLabel;
const entryOf = (symbol) => SYMBOLS.find((x) => x.symbol === symbol);
// Unknown markets (before the catalog loads) are treated as digit markets, like the fallback list.
const kindOf = (symbol) => entryOf(symbol)?.kind ?? 'digits';
const strategyAllowed = (s, symbol) => groupTradeable(s.group, kindOf(symbol));
const KIND_NOTE = {
  digits: 'all contract types',
  ticks: 'Rise/Fall on ticks only',
  minutes: 'analysis + manual minute trades',
  none: 'analysis only (Multipliers/Accumulators)',
};

// Markets the self-scan watches, from the chosen universe (closed markets are skipped).
function scanSymbols() {
  const u = UNIVERSES[$('scan-universe')?.value] ?? UNIVERSES.digits;
  return SYMBOLS.filter((e) => e.open && u.test(e));
}

function renderSymbolSelect() {
  const families = [...new Set(SYMBOLS.map((s) => s.family))];
  $('symbol').innerHTML = families
    .map((f) => `<optgroup label="${esc(f)}">${SYMBOLS.filter((s) => s.family === f)
      .map((s) => `<option value="${esc(s.symbol)}">${esc(s.name)}${s.open ? '' : ' (closed)'}${s.kind === 'none' ? ' · analysis' : s.kind === 'minutes' ? ' · min trades' : ''}</option>`)
      .join('')}</optgroup>`)
    .join('');
  if (!entryOf(state.symbol)) state.symbol = SYMBOLS[0]?.symbol ?? 'R_100';
  $('symbol').value = state.symbol;
}
const robot = new RobotMind($('robot-canvas'));

const client = new DerivClient();

// ---------- setup ----------

function initControls() {
  renderSymbolSelect();
  $('granularity').value = String(state.granularity);
  $('ou-barrier').innerHTML = Array.from({ length: 10 }, (_, d) => `<option ${d === 5 ? 'selected' : ''}>${d}</option>`).join('');
  $('sound').checked = store.get('sound', '0') === '1';
  $('stake').value = store.get('stake', '1');

  $('symbol').onchange = () => { state.symbol = $('symbol').value; store.set('symbol', state.symbol); loadMarket(); };
  $('granularity').onchange = () => {
    state.granularity = Number($('granularity').value);
    store.set('granularity', String(state.granularity));
    loadMarket();
    if (state.scanning) { const rotating = state.autoRotate; stopScanner(); startScanner(); if (rotating) setAutoRotate(true); }
  };
  $('digit-window').onchange = renderDigits;
  $('ou-barrier').onchange = renderDigits;
  $('md-digit').innerHTML = Array.from({ length: 10 }, (_, d) => `<option ${d === 7 ? 'selected' : ''}>${d}</option>`).join('');
  $('md-digit').onchange = renderDigits;
  $('sound').onchange = () => store.set('sound', $('sound').checked ? '1' : '0');
  $('stake').onchange = () => store.set('stake', $('stake').value);
  $('tabs').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.group = b.dataset.group;
    for (const t of $('tabs').children) t.classList.toggle('active', t === b);
    applyCardVisibility();
  };
  $('app-id').value = store.get('appId', '');
  // One click: Deriv's own sign-in + Accept page, then back here (server finishes the login).
  $('oauth-login').onclick = () => {
    const clientId = $('app-id').value.trim();
    store.set('appId', clientId);
    location.href = `/oauth/start${clientId ? `?client_id=${encodeURIComponent(clientId)}` : ''}`;
  };
  $('pat-form').onsubmit = (e) => {
    e.preventDefault();
    store.set('appId', $('app-id').value.trim());
    linkAccount({ kind: 'pat', token: $('token').value.trim(), appId: $('app-id').value.trim() });
  };
  $('acct-select').onchange = () => openAccount($('acct-select').value);
  $('logout').onclick = unlinkAccount;
  $('scan-toggle').onclick = toggleScannerPersist;
  $('scan-universe').value = store.get('scanUniverse', 'digits');
  $('scan-universe').onchange = () => {
    store.set('scanUniverse', $('scan-universe').value);
    if (state.scanning) { const rotating = state.autopilot.on || state.autoRotate; stopScanner(); startScanner(); if (rotating && state.autoRotate) setAutoRotate(true); }
  };
  $('lock-on').onclick = () => state.bestSymbol && switchMarket(state.bestSymbol);
  $('voice').checked = store.get('voice', '0') === '1';
  $('voice').onchange = () => {
    store.set('voice', $('voice').checked ? '1' : '0');
    if ($('voice').checked) speak('Robot voice online.');
  };
  $('auto-rotate').onchange = () => setAutoRotate($('auto-rotate').checked);
  $('rotate-every').onchange = () => { if (state.autoRotate) setAutoRotate(true); };
  window.addEventListener('resize', () => scheduleRender());
}

client.addEventListener('status', (e) => {
  $('conn').dataset.state = e.detail;
  $('conn').textContent = e.detail;
});
let opened = false;
client.addEventListener('open', () => {
  // Streams die with the socket; rebuild them after a reconnect.
  if (!opened) { opened = true; return; }
  loadMarket();
  if (state.scanning) { stopScanner(); startScanner(); }
});

// ---------- market ----------

async function loadMarket() {
  state.market?.stop();
  state.results = {};
  state.records = {};
  state.deep = null;
  state.wasReady.clear();
  const meta = SYMBOLS.find((s) => s.symbol === state.symbol);
  $('sym-name').textContent = meta?.name ?? state.symbol;
  $('sym-kind').textContent = KIND_NOTE[kindOf(state.symbol)];
  $('sym-kind').className = `pill sym-kind ${kindOf(state.symbol)}`;
  applyCardVisibility();
  renderTicket();
  const m = new Market(client, state.symbol, state.granularity);
  state.market = m;
  m.addEventListener('update', (e) => {
    if (state.market !== m) return;
    if (!e.detail || e.detail.newCandle) scheduleBacktests();
    scheduleRender();
  });
  m.addEventListener('error', (e) => console.warn('market error', e.detail));
  try {
    await m.start();
  } catch (err) {
    $('sym-name').textContent = `${meta?.name ?? state.symbol} — ${err.message}`;
  }
}

let btTimer = null;
function scheduleBacktests() {
  clearTimeout(btTimer);
  btTimer = setTimeout(() => {
    const m = state.market;
    if (!m?.loaded) return;
    const snapshot = { candles: m.candles, ind: m.ind, epochs: m.epochs, quotes: m.quotes, digits: m.digits, pip: m.pip, granularity: m.granularity };
    for (const s of STRATEGIES) state.records[s.id] = backtest(s, snapshot, state.barriers[s.id]);
    renderCards();
  }, 50);
}

// ---------- rendering ----------

let rafPending = false;
function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    render();
  });
}

function render() {
  const m = state.market;
  if (!m?.loaded) return;
  $('price').textContent = m.quotes[m.quotes.length - 1].toFixed(m.pip);
  drawChart();
  renderIndicators();
  renderDigits();
  renderCards();
  if (performance.now() - state.lastMind > 1000) updateMind();
}

// ---------- robot mind & deep analysis ----------

function updateMind() {
  const m = state.market;
  if (!m?.loaded) return;
  state.lastMind = performance.now();
  state.deep = deepAnalysis(m);
  state.brain = think(state.deep, state.results, withMemory(state.records));
  renderDeep();
  renderRobot();
  renderLearning();
}

// Replay records pooled with what the robot has learned from live paper trades.
function withMemory(records) {
  const out = {};
  for (const s of STRATEGIES) out[s.id] = combineRecords(records[s.id], memoryRecord(state.memory, s.id));
  return out;
}

function renderRobot() {
  const b = state.brain;
  const el = $('robot-action');
  el.className = `robot-action ${b.mood}`;
  if (b.action) {
    el.innerHTML = `${esc(b.action.group)} → ${esc(b.action.side)} · ${esc(b.action.contract.label)}<small>${esc(b.action.name)} · signal ${pct(b.strength, 0)}</small>`;
  } else if (b.mood === 'wait') {
    el.innerHTML = `Setup found — waiting for the entry trigger<small>Watch the strategy cards for the exact trigger</small>`;
  } else {
    const pick = state.bestSymbol && state.bestSymbol !== state.symbol ? `Self-scan suggests ${nameOf(state.bestSymbol)}` : state.autoRotate ? 'Rotating through markets to find one' : 'Turn on auto-rotate to hunt across all markets';
    el.innerHTML = `Standing aside — no clean setup on ${esc(shortName(state.symbol))}<small>${esc(pick)}</small>`;
  }

  const ends = { 'Rise / Fall': ['FALL', 'RISE'], 'Even / Odd': ['ODD', 'EVEN'], 'Over / Under': ['OVER', 'UNDER'], 'Matches / Differs': ['DIFFERS', 'MATCHES'] };
  $('robot-gauges').innerHTML = Object.entries(b.verdicts)
    .map(([group, v]) => {
      const [left, right] = ends[group];
      const w = v.confidence * 50;
      const pos = v.bias === right ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
      const color = v.confidence > 0.5 ? 'var(--green)' : v.confidence > 0.25 ? 'var(--accent)' : 'var(--muted)';
      return `<div class="gauge"><span><em>${left}</em>${esc(group)}<em>${right}</em></span><b>${v.bias} ${pct(v.confidence, 0)}</b><div class="scale"><i style="${pos};background:${color}"></i></div></div>`;
    })
    .join('');

  addThoughts(b.thoughts);
  robot.setMood(b.mood);
  // The orbit fits ~14 markets: show the strongest scanned ones, always including the one in view.
  const orbit = [...new Set([state.symbol, ...[...state.scanScores.values()].sort((x, y) => y.smooth - x.smooth).map((x) => x.symbol)])].slice(0, 14);
  if (orbit.length < 2) orbit.push(...scanSymbols().map((e) => e.symbol).filter((s) => !orbit.includes(s)).slice(0, 13));
  robot.setMarkets(
    orbit.map((symbol) => {
      const s = state.scanScores.get(symbol) ?? (symbol === state.symbol ? { score: b.marketScore, ready: Boolean(b.action) } : null);
      return { id: symbol, label: shortName(symbol), score: (s?.score ?? 0) / 2, ready: s?.ready ?? false, best: symbol === state.bestSymbol };
    }),
    state.symbol,
  );
}

// Keep a short rolling log; a thought is new when its wording (ignoring numbers) changes.
function addThoughts(texts) {
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  for (const text of texts) {
    const key = text.replace(/[-\d.]+/g, '#');
    const topic = `${state.symbol} ${text.split(' ').slice(0, 2).join(' ')}`;
    const last = state.thoughts.find((t) => t.topic === topic);
    if (last?.key === key) continue;
    state.thoughts.unshift({ time: now, text: `[${shortName(state.symbol)}] ${text}`, key, topic, fresh: true });
  }
  state.thoughts.length = Math.min(state.thoughts.length, 30);
  // Only newly added lines animate in; re-rendering must not restart the fade on old ones.
  $('robot-thoughts').innerHTML = state.thoughts
    .slice(0, 8)
    .map((t) => `<li class="${t.fresh ? 'fresh' : ''}"><time>${t.time}</time>${esc(t.text)}</li>`)
    .join('');
  for (const t of state.thoughts) t.fresh = false;
}

function renderDeep() {
  const d = state.deep;
  const m = state.market;
  const kv = (k, v, cls = '') => `<div class="kv"><span>${k}</span><b class="${cls}">${v}</b></div>`;
  const random = d.chi.pValue > 0.05;
  $('deep-random').innerHTML =
    kv('Digit uniformity (χ² p-value)', `${d.chi.pValue.toFixed(3)} · ${random ? 'random' : 'skewed'}`, random ? '' : 'warn') +
    kv('Entropy (100% = pure chance)', `${(d.entropy * 100).toFixed(2)}%`) +
    kv('Even/odd runs test', `z ${d.runs.z.toFixed(2)} · ${d.runs.z < -2 ? 'streaky' : d.runs.z > 2 ? 'alternating' : 'normal'}`, Math.abs(d.runs.z) > 2 ? 'warn' : '') +
    kv('Even share, last 100 (z)', d.parityZ.toFixed(2), Math.abs(d.parityZ) > 2 ? 'warn' : '');

  const dir = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : '');
  $('deep-trend').innerHTML =
    d.mtf.map((t) => kv(`Trend ${t.tf}`, `${t.dir > 0 ? '▲' : t.dir < 0 ? '▼' : '▬'} ${t.label}`, dir(t.dir))).join('') +
    kv('ADX (trend strength)', `${num(d.adx, 1)} · ${d.adx > 25 ? 'trending' : d.adx < 20 ? 'ranging' : 'building'}`) +
    kv('+DI / −DI', `${num(d.plusDI, 1)} / ${num(d.minusDI, 1)}`, dir(d.plusDI - d.minusDI)) +
    kv('Supertrend', `${d.supertrend.dir > 0 ? 'bullish' : 'bearish'} @ ${num(d.supertrend.level, m.pip)}`, dir(d.supertrend.dir)) +
    kv('Volatility (ATR percentile)', `${pct(d.atrPct, 0)} · ${d.atrPct > 0.8 ? 'wild' : d.atrPct < 0.2 ? 'calm' : 'normal'}`, d.atrPct > 0.8 ? 'warn' : '');

  const price = m.quotes[m.quotes.length - 1];
  const lvl = (l, kind) => kv(`${kind} · ${l.touches} touches`, `${l.price.toFixed(m.pip)} (${((Math.abs(l.price - price) / d.atr) || 0).toFixed(1)} ATR)`, kind === 'Resistance' ? 'down' : 'up');
  $('deep-levels').innerHTML =
    [...d.levels.resistance.slice().reverse().map((l) => lvl(l, 'Resistance')), kv('Price now', price.toFixed(m.pip), 'warn'), ...d.levels.support.map((l) => lvl(l, 'Support'))].join('') ||
    '<span class="muted">No repeated swing levels yet.</span>';

  const cur = m.digits[m.digits.length - 1];
  const row = d.transitions[cur];
  $('deep-next-label').textContent = `after a ${cur}, the next digit was (${row.total} samples):`;
  let html = '<span class="hd"></span>' + Array.from({ length: 10 }, (_, k) => `<span class="hd">${k}</span>`).join('');
  d.transitions.forEach((r, from) => {
    html += `<span class="hd">${from}</span>`;
    r.probs.forEach((p) => {
      const heat = Math.min(1, Math.max(0, (p - 0.05) / 0.1));
      html += `<span class="${from === cur ? 'row-current' : ''}" style="background:rgba(${Math.round(76 + 169 * heat)},${Math.round(141 + 43 * heat)},${Math.round(255 - 194 * heat)},${0.15 + 0.6 * heat})">${Math.round(p * 100)}</span>`;
    });
  });
  $('deep-matrix').innerHTML = html;

  $('deep-gaps').innerHTML = d.gaps
    .map((g, k) => `<div class="gap ${g > 25 ? 'overdue' : ''}"><small>${k}</small><b>${g}</b></div>`)
    .join('');
}

// ---------- auto-rotation ----------

function setAutoRotate(on) {
  state.autoRotate = on;
  $('auto-rotate').checked = on;
  clearInterval(state.rotateTimer);
  if (!on) return;
  if (!state.scanning) startScanner();
  addThoughts([`Auto-rotate on — re-ranking all markets every ${$('rotate-every').value}s`]);
  state.rotateTimer = setInterval(rotate, Number($('rotate-every').value) * 1000);
}

// Follow the self-scan's pick (already smoothed by pickBest's hysteresis).
function rotate() {
  const best = state.scanScores.get(state.bestSymbol);
  if (!best) return;
  if (best.symbol !== state.symbol) {
    addThoughts([`Rotating to ${best.name}: ${best.ready ? 'READY signal' : 'strongest setup'} (${pct(best.brain.strength, 0)})`]);
    switchMarket(best.symbol);
  } else {
    addThoughts([`Staying on ${shortName(state.symbol)} — still the best volatility`]);
  }
}

function switchMarket(symbol) {
  state.symbol = symbol;
  $('symbol').value = symbol;
  store.set('symbol', symbol);
  loadMarket();
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawChart() {
  const m = state.market;
  const canvas = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = 360;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const ind = m.ind;
  const n = Math.min(70, m.candles.length);
  const start = m.candles.length - n;
  const axis = 64;
  const plotW = W - axis;
  const priceH = H * 0.7;
  const macdTop = priceH + 14;
  const macdH = H - macdTop - 4;
  const step = plotW / n;

  let lo = Infinity, hi = -Infinity;
  for (let i = start; i < m.candles.length; i++) {
    lo = Math.min(lo, ind.low[i], Number.isFinite(ind.bb.lower[i]) ? ind.bb.lower[i] : Infinity);
    hi = Math.max(hi, ind.high[i], Number.isFinite(ind.bb.upper[i]) ? ind.bb.upper[i] : -Infinity);
  }
  const pad = (hi - lo) * 0.06 || 1;
  lo -= pad; hi += pad;
  const y = (v) => 6 + (1 - (v - lo) / (hi - lo)) * (priceH - 12);
  const x = (i) => (i - start) * step + step / 2;

  const muted = cssVar('--muted');
  const line = cssVar('--line');
  ctx.font = '11px JetBrains Mono, monospace';
  ctx.fillStyle = muted;
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const v = lo + ((hi - lo) * g) / 4;
    const yy = y(v);
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(v.toFixed(m.pip), plotW + 6, yy + 4);
  }

  const series = (arr, color, dash = []) => {
    ctx.strokeStyle = color;
    ctx.setLineDash(dash);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let started = false;
    for (let i = start; i < m.candles.length; i++) {
      if (!Number.isFinite(arr[i])) continue;
      if (!started) { ctx.moveTo(x(i), y(arr[i])); started = true; } else ctx.lineTo(x(i), y(arr[i]));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const purple = cssVar('--purple');
  ctx.globalAlpha = 0.7;
  series(ind.bb.upper, purple, [4, 3]);
  series(ind.bb.lower, purple, [4, 3]);
  ctx.globalAlpha = 0.45;
  series(ind.bb.mid, purple);
  ctx.globalAlpha = 1;

  const green = cssVar('--green');
  const red = cssVar('--red');
  const bodyW = Math.max(2, step * 0.62);
  for (let i = start; i < m.candles.length; i++) {
    const c = m.candles[i];
    const color = c.close >= c.open ? green : red;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(x(i), y(c.high)); ctx.lineTo(x(i), y(c.low)); ctx.stroke();
    const top = y(Math.max(c.open, c.close));
    ctx.fillRect(x(i) - bodyW / 2, top, bodyW, Math.max(1, y(Math.min(c.open, c.close)) - top));
  }
  series(ind.ma, cssVar('--accent'));
  series(ind.hma, cssVar('--blue'));

  const deep = state.deep;
  if (deep) {
    // Supertrend only where it fits the visible price range.
    const st = deep.supertrend.line.map((v) => (v >= lo && v <= hi ? v : NaN));
    series(st, '#2dd4bf', [1, 3]);
    ctx.font = '10px JetBrains Mono, monospace';
    for (const [list, tag] of [[deep.levels.support, 'S'], [deep.levels.resistance, 'R']]) {
      for (const l of list) {
        if (l.price < lo || l.price > hi) continue;
        ctx.strokeStyle = 'rgba(230,237,243,0.45)';
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(0, y(l.price)); ctx.lineTo(plotW, y(l.price)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = tag === 'S' ? green : red;
        ctx.fillText(`${tag}×${l.touches}`, 4, y(l.price) - 3);
      }
    }
  }

  const last = m.quotes[m.quotes.length - 1];
  ctx.strokeStyle = cssVar('--text');
  ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(0, y(last)); ctx.lineTo(plotW, y(last)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = cssVar('--accent');
  ctx.fillRect(plotW + 2, y(last) - 8, axis - 4, 16);
  ctx.fillStyle = '#1b1300';
  ctx.fillText(last.toFixed(m.pip), plotW + 6, y(last) + 4);

  // MACD panel
  const { line: ml, signal: ms, hist } = ind.macd;
  let mmax = 0;
  for (let i = start; i < m.candles.length; i++) mmax = Math.max(mmax, Math.abs(hist[i]) || 0, Math.abs(ml[i]) || 0, Math.abs(ms[i]) || 0);
  mmax ||= 1;
  const my = (v) => macdTop + macdH / 2 - (v / mmax) * (macdH / 2);
  ctx.fillStyle = muted;
  ctx.fillText('MACD', plotW + 6, macdTop + 10);
  const colors = { 'dark-green': green, 'faded-green': cssVar('--green-faded'), 'dark-red': red, 'faded-red': cssVar('--red-faded') };
  for (let i = start; i < m.candles.length; i++) {
    if (!Number.isFinite(hist[i])) continue;
    ctx.fillStyle = colors[histColor(hist, i)] ?? line;
    const y0 = my(0), y1 = my(hist[i]);
    ctx.fillRect(x(i) - bodyW / 2, Math.min(y0, y1), bodyW, Math.max(1, Math.abs(y1 - y0)));
  }
  const mseries = (arr, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let s = false;
    for (let i = start; i < m.candles.length; i++) {
      if (!Number.isFinite(arr[i])) continue;
      if (!s) { ctx.moveTo(x(i), my(arr[i])); s = true; } else ctx.lineTo(x(i), my(arr[i]));
    }
    ctx.stroke();
  };
  mseries(ml, cssVar('--blue'));
  mseries(ms, '#ff8a3d');
}

function renderIndicators() {
  const m = state.market;
  const ind = m.ind;
  const i = m.candles.length - 1;
  const dir = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const tiles = [
    ['Hull MA', ind.close[i] > ind.hma[i] ? 'price above' : 'price below', dir(ind.close[i] - ind.hma[i])],
    ['Stoch RSI K/D', `${num(ind.stochRsi.k[i], 0)} / ${num(ind.stochRsi.d[i], 0)}`, dir(ind.stochRsi.k[i] - ind.stochRsi.d[i])],
    ['Aroon up/down', `${num(ind.aroon.up[i], 0)} / ${num(ind.aroon.down[i], 0)}`, dir(ind.aroon.up[i] - ind.aroon.down[i])],
    ['A/D (3 bars)', ind.ad[i] - ind.ad[i - 3] > 0 ? 'rising' : 'falling', dir(ind.ad[i] - ind.ad[i - 3])],
    ['MACD hist', histColor(ind.macd.hist, i).replace('-', ' '), dir(ind.macd.hist[i])],
    ['Chaikin vol', num(ind.chaikin[i]), dir(ind.chaikin[i])],
    ['KST − signal', num(ind.kst.line[i] - ind.kst.signal[i]), dir(ind.kst.line[i] - ind.kst.signal[i])],
    ['Connors RSI', num(ind.crsi[i], 1), dir(ind.crsi[i] - 50)],
    ['RSI 14', num(ind.rsi[i], 1), dir(ind.rsi[i] - 50)],
    ['BB width', `${num(ind.bb.width[i] * 1000, 3)}‰`, ''],
    ['TSI', num(ind.tsi[i], 3), dir(ind.tsi[i])],
    ['Coppock', num(ind.coppock[i], 3), dir(ind.coppock[i] - ind.coppock[i - 1])],
    ['Mass index', num(ind.mass[i]), dir(ind.mass[i] - ind.mass[i - 1])],
    ['Double EMA', num(ind.dema[i], m.pip), dir(ind.close[i] - ind.dema[i])],
  ];
  $('ind-strip').innerHTML = tiles.map(([k, v, c]) => `<div class="ind"><span>${k}</span><b class="${c}">${esc(v)}</b></div>`).join('');
}

function renderDigits() {
  const m = state.market;
  if (!m?.loaded) return;
  const recent = m.digits.slice(-40);
  $('digit-stream').innerHTML = recent
    .map((d, k) => `<span class="chip ${d % 2 ? 'o' : 'e'}${k === recent.length - 1 ? ' newest' : ''}">${d}</span>`)
    .join('');

  const win = Number($('digit-window').value);
  const barrier = Number($('ou-barrier').value);
  const sample = m.digits.slice(-win);
  const st = digitStats(sample, barrier);
  const maxP = Math.max(...st.dist, 0.0001);
  const current = m.digits[m.digits.length - 1];
  $('digit-bars').innerHTML = st.dist
    .map((p, d) => {
      const cls = d === st.hottest ? 'hot' : d === st.coldest ? 'cold' : '';
      return `<div class="bar ${cls} ${d === current ? 'current' : ''}"><small>${pct(p, 1)}</small><i style="height:${(p / maxP) * 80}%"></i><b>${d}</b></div>`;
    })
    .join('');

  const streak = parityStreak(m.digits);
  const pe = parityEntry(m.digits);
  $('digit-stats').innerHTML = `
    <div class="stat"><span>Even / Odd (${sample.length})</span><b>${pct(st.evenPct)} / ${pct(st.oddPct)}</b><div class="meter"><i style="width:${st.evenPct * 100}%"></i></div></div>
    <div class="stat"><span>Current streak</span><b>${streak.length}× ${streak.kind === 'E' ? 'EVEN' : 'ODD'}</b></div>
    <div class="stat"><span>Guide pattern</span><b>${pe ? `${pe.pattern} → ${pe.market}` : 'none'}</b></div>
    <div class="stat"><span>Most frequent</span><b>${st.hottest}</b></div>
    <div class="stat"><span>Least frequent</span><b>${st.coldest}</b></div>
    <div class="stat"><span>Last digit</span><b>${current}</b></div>`;
  const eq = st.dist[barrier];
  $('ou-stats').innerHTML = `Over ${barrier}: <b>${pct(st.overPct)}</b> · Under ${barrier}: <b>${pct(st.underPct)}</b> · Equal: <b>${pct(eq)}</b>`;

  // Matches / Differs: how often the chosen digit came up, against the 10% / 90% fair odds.
  const md = Number($('md-digit').value);
  let gap = 0;
  for (let k = m.digits.length - 1; k >= 0 && m.digits[k] !== md; k--) gap++;
  $('md-stats').innerHTML = `Matches ${md}: <b>${pct(st.dist[md])}</b> <span class="muted">(fair 10%)</span> · Differs ${md}: <b>${pct(1 - st.dist[md])}</b> <span class="muted">(fair 90%)</span> · last seen <b>${gap}</b> ticks ago`;
}

// ---------- strategy cards ----------

const cards = {};

// Create cards for strategies that don't have one and drop cards for removed ones.
function buildCards() {
  const root = $('cards');
  const ids = new Set(STRATEGIES.map((s) => s.id));
  for (const id of Object.keys(cards)) {
    if (!ids.has(id)) { cards[id].el.remove(); delete cards[id]; }
  }
  for (const s of STRATEGIES) {
    if (cards[s.id]) continue;
    state.barriers[s.id] ??= s.barrier;
    const el = document.createElement('article');
    el.className = `card${s.learned ? ' learned-card' : ''}`;
    el.innerHTML = `
      <div class="card-top">
        <div><small>${esc(s.group)} · ${esc(s.bot)}${s.page ? ` · guide p.${s.page}` : ''}</small><h3>${esc(s.name)}</h3></div>
        <span class="side"></span>
      </div>
      <div class="confluence"><div class="track"><i></i></div><span class="score"></span></div>
      <ul class="checks"></ul>
      <div class="meta"><span class="status"></span><span class="runs"></span><span class="contract"></span></div>
      <div class="record muted">Building track record…</div>
      ${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}
      <div class="card-actions"><button class="trade" type="button" disabled>Link account to trade</button></div>
      <div class="card-manual">
        <label class="toggle"><input type="checkbox" class="bot-allow"> Autopilot may trade this</label>
        <label class="small">Own stake <input class="strat-stake" type="number" min="0.35" step="0.01" placeholder="default"></label>
      </div>`;
    // Manual per-strategy settings, remembered in this browser.
    const allow = el.querySelector('.bot-allow');
    allow.checked = store.get(`strat.${s.id}.bot`, '1') === '1';
    allow.onchange = () => { store.set(`strat.${s.id}.bot`, allow.checked ? '1' : '0'); renderBotStrategies(); };
    const ownStake = el.querySelector('.strat-stake');
    ownStake.value = store.get(`strat.${s.id}.stake`, '');
    ownStake.onchange = () => { store.set(`strat.${s.id}.stake`, ownStake.value); renderBotStrategies(); renderCards(); };
    if (s.barriers) {
      const sel = document.createElement('select');
      sel.innerHTML = s.barriers.map((b) => `<option ${b === s.barrier ? 'selected' : ''}>${b}</option>`).join('');
      sel.onchange = () => { state.barriers[s.id] = Number(sel.value); scheduleBacktests(); renderCards(); };
      const label = document.createElement('label');
      label.className = 'small';
      label.append('Barrier ', sel);
      el.querySelector('.meta').append(label);
    }
    el.querySelector('.trade').onclick = () => placeTrade(s);
    root.append(el);
    cards[s.id] = {
      el,
      side: el.querySelector('.side'),
      bar: el.querySelector('.track i'),
      score: el.querySelector('.score'),
      checks: el.querySelector('.checks'),
      status: el.querySelector('.status'),
      runs: el.querySelector('.runs'),
      contract: el.querySelector('.contract'),
      record: el.querySelector('.record'),
      trade: el.querySelector('.trade'),
    };
  }
  applyCardVisibility();
}

// Cards show when they match the tab and the market offers their contracts.
function applyCardVisibility() {
  let hidden = 0;
  for (const s of STRATEGIES) {
    const c = cards[s.id];
    if (!c) continue;
    const allowed = strategyAllowed(s, state.symbol);
    if (!allowed) hidden++;
    c.el.hidden = !allowed || (state.group !== 'all' && s.group !== state.group);
  }
  const name = entryOf(state.symbol)?.name ?? state.symbol;
  $('board-note').textContent = hidden
    ? `${hidden} strateg${hidden === 1 ? 'y is' : 'ies are'} hidden: Deriv doesn't offer ${kindOf(state.symbol) === 'ticks' ? 'digit contracts' : 'tick contracts'} on ${name}. Use the Quick trade ticket for manual trades here.`
    : '';
}

function renderCards() {
  const m = state.market;
  if (!m?.loaded) return;
  const i = m.candles.length - 1;
  const live = m.live();
  for (const s of STRATEGIES) {
    // Strategies whose contracts this market doesn't offer are hidden and kept out of the brain.
    if (!strategyAllowed(s, state.symbol)) { delete state.results[s.id]; continue; }
    const r = evaluate(s, m.ind, i, live, state.barriers[s.id]);
    state.results[s.id] = r;
    const c = cards[s.id];
    c.el.classList.toggle('ready', r.ready);
    c.el.classList.toggle('setup', r.setupOk && !r.ready);
    c.side.className = `side ${r.side}`;
    c.side.textContent = r.side;
    c.bar.style.width = `${r.score * 100}%`;
    c.score.textContent = `${r.passed}/${r.total} rules`;
    c.checks.innerHTML =
      r.checks.map((k) => `<li class="${k.pass ? 'pass' : 'fail'}"><span class="mark">${k.pass ? '✓' : '✗'}</span>${esc(k.label)}<em>${esc(k.detail)}</em></li>`).join('') +
      `<li class="entry ${r.entry.pass ? 'pass' : 'fail'}"><span class="mark">${r.entry.pass ? '✓' : '…'}</span>Entry: ${esc(r.entry.label)}<em>${esc(r.entry.detail)}</em></li>`;
    c.status.className = `status ${r.ready ? 'ready' : r.setupOk ? 'setup' : 'none'}`;
    c.status.textContent = r.ready ? 'READY' : r.setupOk ? 'SETUP ✓ · WAIT ENTRY' : 'NO SETUP';
    c.runs.innerHTML = `Max runs <b>${r.runs}</b>`;
    c.contract.innerHTML = `<b>${esc(r.contract.label)}</b> · chance ${pct(r.baseline, 0)}`;

    const rec = state.records[s.id];
    const mem = memoryRecord(state.memory, s.id);
    const memLine = mem ? ` · robot memory <b>${mem.wins}/${mem.trades}</b> live (${pct(mem.winRate, 0)})` : '';
    if (rec) {
      if (!rec.trades) {
        c.record.innerHTML = `Track record: <b>${rec.signals}</b> signals in the replayed history — not enough to judge yet.${memLine}`;
      } else {
        const cls = rec.ci[0] > rec.baseline ? 'good' : rec.ci[1] < rec.baseline ? 'bad' : '';
        c.record.innerHTML = `Track record: <b>${rec.signals}</b> signals · ${rec.trades} trades · win <b class="${cls}">${pct(rec.winRate)}</b> (95% range ${pct(rec.ci[0], 0)}–${pct(rec.ci[1], 0)}) vs chance ${pct(rec.baseline, 0)}${memLine}`;
      }
    }

    // The pre-trade check runs on every card, so a blocked trade says exactly why.
    const blockers = state.account ? tradeBlockers(s.id) : [];
    c.trade.disabled = !state.account || !r.ready || blockers.length > 0;
    c.trade.textContent = !state.account ? 'Link account to trade' : blockers.length ? `Blocked: ${blockers[0]}` : `Buy ${r.contract.label} · ${num(stakeFor(s.id))} ${state.account.currency}`;
    c.trade.title = blockers.join('\n');

    if (r.ready && !state.wasReady.has(s.id)) {
      state.wasReady.add(s.id);
      if ($('sound').checked) beep();
    } else if (!r.ready) state.wasReady.delete(s.id);
  }
}

let audio;
function beep() {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.35);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.35);
  } catch { /* audio unavailable */ }
}

function tickClock() {
  const m = state.market;
  const left = m?.loaded ? m.secondsLeft : NaN;
  const el = $('countdown');
  if (!Number.isFinite(left)) { el.textContent = '--:--'; return; }
  const s = Math.max(0, Math.ceil(left));
  el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  el.classList.toggle('hot', s <= 3);
  // Countdown entries (run at 00:02) change without a new tick.
  if (m?.loaded) renderCards();
  if (riskLocked() || state.risk.wasLocked) {
    // Keep the lock countdown live, and re-enable trading the moment it ends.
    state.risk.wasLocked = riskLocked();
    renderRisk();
  }
}

// ---------- account & trading ----------

// auth: { kind: 'oauth' } after "Log in with Deriv", or { kind: 'pat', token, appId }.
async function linkAccount(auth) {
  if (auth.kind === 'pat' && !auth.token) return;
  try {
    const all = auth.kind === 'oauth' ? await listAccountsOAuth() : await listAccounts(auth.token, auth.appId);
    const accounts = all.filter((a) => a.status !== 'inactive');
    if (!accounts.length) throw new Error('No active Options accounts on this Deriv login.');
    state.auth = auth;
    state.accounts = accounts;
    $('token').value = '';
    $('link-error').hidden = true;
    $('acct-select').innerHTML = accounts
      .map((a) => `<option value="${esc(a.account_id)}">${esc(a.account_id)} · ${esc(a.account_type)} · ${esc(a.currency)}</option>`)
      .join('');
    // Start on a demo account when there is one.
    const first = accounts.find((a) => a.account_type === 'demo') ?? accounts[0];
    $('acct-select').value = first.account_id;
    $('login-form').hidden = true;
    $('account-info').hidden = false;
    $('trade-log').innerHTML = '';
    await openAccount(first.account_id);
  } catch (err) {
    showLinkError(`Could not link Deriv account: ${err.message}`);
  }
}

function showLinkError(msg) {
  $('link-error').textContent = msg;
  $('link-error').hidden = false;
}

// After Deriv redirects back from its Accept page, pick up the server-side login.
async function resumeOAuth() {
  const params = new URLSearchParams(location.search);
  if (params.has('linked') || params.has('link_error')) history.replaceState(null, '', location.pathname);
  if (params.get('link_error')) showLinkError(params.get('link_error'));
  try {
    const s = await oauthSession();
    if (s.linked) await linkAccount({ kind: 'oauth' });
  } catch { /* server without OAuth support: token login still works */ }
}

async function openAccount(accountId) {
  const acct = state.accounts.find((a) => a.account_id === accountId);
  if (!acct) return;
  if (state.autopilot.on) haltAutopilot('account switched');
  state.trader?.close();
  state.account = acct;
  const demo = acct.account_type === 'demo';
  $('acct-type').textContent = acct.account_type;
  $('acct-type').className = `pill ${demo ? 'demo' : 'real'}`;
  $('acct-balance').textContent = `${num(acct.balance)} ${acct.currency}`;
  state.balance = Number(acct.balance) || 0;
  const trader = state.auth.kind === 'oauth' ? tradingClientOAuth(accountId) : tradingClient(state.auth.token, state.auth.appId, accountId);
  state.trader = trader;
  // A dropped trading socket must stop the autopilot rather than let it fire blind.
  trader.addEventListener('status', (e) => { if (e.detail === 'offline' && state.autopilot?.on) haltAutopilot('Trading connection lost'); });
  trader.addEventListener('open', () => {
    trader.subscribe({ balance: 1 }, (msg) => {
      if (!msg.balance) return;
      $('acct-balance').textContent = `${num(msg.balance.balance)} ${msg.balance.currency}`;
      state.balance = Number(msg.balance.balance) || 0;
      renderRisk();
    }).catch(() => {});
  });
  try {
    await trader.connect();
  } catch (err) {
    $('acct-balance').textContent = `trading socket failed: ${err.message}`;
  }
  renderCards();
  renderAutopilot();
  renderTicketButton();
}

function unlinkAccount() {
  if (state.autopilot?.on) haltAutopilot('Account unlinked');
  if (state.auth?.kind === 'oauth') oauthLogout().catch(() => {});
  state.trader?.close();
  state.trader = null;
  state.account = null;
  state.balance = 0;
  state.accounts = [];
  state.auth = null;
  $('login-form').hidden = false;
  $('account-info').hidden = true;
  renderCards();
  renderAutopilot();
  renderTicketButton();
}

// Manual Buy on a strategy card (main market).
async function placeTrade(strategy) {
  const r = state.results[strategy.id];
  if (!r || !state.account || !state.trader) return;
  const stake = stakeFor(strategy.id);
  if (!(stake > 0)) return alert('Enter a stake first.');
  // Final pre-trade check: the card may have been rendered a moment before the limits changed.
  const blockers = tradeBlockers(strategy.id, state.symbol);
  if (blockers.length) return alert(`Trade blocked by your risk limits:\n\n• ${blockers.join('\n• ')}`);
  const acct = state.account;
  if (acct.account_type !== 'demo' && !confirm(`REAL MONEY on ${acct.account_id}: buy ${r.contract.label} on ${state.symbol} for ${stake} ${acct.currency}?`)) return;
  await executeTrade({ symbol: state.symbol, contract: r.contract, stake, meta: { strategyId: strategy.id, strategyName: strategy.name, group: strategy.group } }).catch(() => {});
}

// Buy one contract and settle it into the risk session and the earnings history.
// Shared by manual Buy, the Quick trade ticket and Autopilot.
// Resolves with { won, profit } once the contract is sold, or throws if the buy fails.
async function executeTrade({ symbol, contract, stake, auto = false, meta = {} }) {
  const acct = state.account;
  const trader = state.trader;
  const parameters = {
    amount: stake,
    basis: 'stake',
    contract_type: contract.contract_type,
    currency: acct.currency,
    duration: contract.duration,
    duration_unit: contract.duration_unit ?? 't',
    underlying_symbol: symbol,
  };
  if (contract.barrier !== undefined) parameters.barrier = String(contract.barrier);
  const tag = auto ? '[AUTO] ' : '';
  const row = document.createElement('li');
  row.textContent = `${new Date().toLocaleTimeString()} · ${tag}${shortName(symbol)} · ${contract.label} · ${stake} ${acct.currency} · buying…`;
  $('trade-log').prepend(row);
  try {
    const { buy } = await trader.send({ buy: 1, price: stake, parameters });
    row.textContent = `${new Date().toLocaleTimeString()} · ${tag}#${buy.contract_id} · ${shortName(symbol)} · ${contract.label} · ${buy.buy_price} ${acct.currency} · open`;
    return await new Promise((resolve, reject) => {
      let sub = null;
      let done = false;
      trader.subscribe({ proposal_open_contract: 1, contract_id: buy.contract_id }, (msg) => {
        const poc = msg.proposal_open_contract;
        if (!poc?.is_sold || done) return;
        done = true;
        const profit = Number(poc.profit) || 0;
        const won = profit > 0;
        row.className = won ? 'won' : 'lost';
        row.textContent = `${new Date().toLocaleTimeString()} · ${tag}#${buy.contract_id} · ${shortName(symbol)} · ${contract.label} · ${won ? 'WON' : 'LOST'} ${num(profit)} ${acct.currency}`;
        recordRealOutcome(symbol, won, profit);
        recordHistory({
          t: Date.now(), symbol, stake, profit, won, auto,
          contract: contract.label, type: contract.contract_type,
          strategyId: meta.strategyId ?? null, strategyName: meta.strategyName ?? 'Manual ticket', group: meta.group ?? groupOfType(contract.contract_type),
          acct: acct.account_type, accountId: acct.account_id, currency: acct.currency,
        });
        sub?.forget();
        resolve({ won, profit });
      }).then((s) => { sub = s; if (done) s.forget(); }, reject);
    });
  } catch (err) {
    row.className = 'lost';
    row.textContent += ` failed: ${err.message}`;
    throw err;
  }
}

// ---------- scanner ----------

async function startScanner() {
  if (state.scanning) return;
  state.scanning = true;
  store.set('autoscan', '1');
  $('scan-toggle').textContent = 'Pause self-scan';
  $('scan-body').innerHTML = '<tr><td colspan="6" class="muted">Bringing markets online…</td></tr>';
  for (const { symbol } of scanSymbols()) {
    if (!state.scanning) return;
    const m = new Market(client, symbol, state.granularity, { candleCount: 300, tickCount: 1000 });
    state.scanner.set(symbol, m);
    m.addEventListener('update', scheduleScanRender);
    m.addEventListener('update', (e) => { if (e.detail?.tick) settlePaper(symbol, m); });
    m.start().catch((err) => console.warn('scanner', symbol, err.message));
    await new Promise((r) => setTimeout(r, 250)); // stay under Deriv's request rate limit
  }
}

function stopScanner() {
  if (state.autoRotate) setAutoRotate(false);
  state.scanning = false;
  state.scanScores.clear();
  state.scanRecords.clear();
  for (const m of state.scanner.values()) m.stop();
  state.scanner.clear();
  $('scan-toggle').textContent = 'Resume self-scan';
  $('scan-status').textContent = 'Self-scan paused';
  $('scan-body').innerHTML = '<tr><td colspan="6" class="muted">Self-scan is paused.</td></tr>';
}

// Called by the pause button; remembers the choice for next visit.
function toggleScannerPersist() {
  if (state.scanning) { stopScanner(); store.set('autoscan', '0'); } else startScanner();
}

let scanTimer = null;
function scheduleScanRender() {
  if (scanTimer) return;
  scanTimer = setTimeout(() => { scanTimer = null; renderScanner(); }, 1000);
}

const nameOf = (symbol) => SYMBOLS.find((x) => x.symbol === symbol)?.name ?? symbol;

// Score one scanned market with the same brain the main view uses.
function scoreMarket(symbol, m) {
  const i = m.candles.length - 1;
  const live = m.live();
  // Only strategies whose contracts this market offers take part.
  const results = Object.fromEntries(STRATEGIES.filter((s) => strategyAllowed(s, symbol)).map((s) => [s.id, evaluate(s, m.ind, i, live, state.barriers[s.id])]));
  // Track records are replayed once per new candle per market.
  let cached = state.scanRecords.get(symbol);
  if (cached?.epoch !== m.candles[i].epoch) {
    const snap = { candles: m.candles, ind: m.ind, epochs: m.epochs, quotes: m.quotes, digits: m.digits, pip: m.pip, granularity: m.granularity };
    cached = { epoch: m.candles[i].epoch, records: Object.fromEntries(STRATEGIES.map((s) => [s.id, backtest(s, snap, state.barriers[s.id])])) };
    state.scanRecords.set(symbol, cached);
  }
  openPaperTrades(symbol, m, results);
  const brain = think(deepAnalysis(m), results, withMemory(cached.records));
  // READY flickers tick by tick, so rank on a smoothed score (~5 sweep half-life).
  const prev = state.scanScores.get(symbol);
  const smooth = prev ? prev.smooth * 0.85 + brain.marketScore * 0.15 : brain.marketScore;
  const entry = { symbol, name: nameOf(symbol), score: brain.marketScore, smooth, ready: Boolean(brain.action), brain, even: digitStats(m.digits.slice(-200)).evenPct, price: m.quotes[m.quotes.length - 1].toFixed(m.pip) };
  state.scanScores.set(symbol, entry);
  return entry;
}

function renderScanner() {
  if (!state.scanning) return;
  state.sweeps++;
  const ranked = [];
  let loading = 0;
  for (const symbol of state.scanner.keys()) {
    const m = state.scanner.get(symbol);
    if (m?.loaded) ranked.push(scoreMarket(symbol, m));
    else loading++;
  }
  ranked.sort((a, b) => b.smooth - a.smooth);
  $('scan-status').textContent = `${ranked.length}/${scanSymbols().length} markets online · sweep #${state.sweeps} · ${new Date().toLocaleTimeString()}${loading ? ` · ${loading} connecting` : ''}`;

  $('scan-body').innerHTML = ranked
    .map((r, k) => {
      const b = r.brain.best;
      const status = r.brain.mood === 'go' ? 'READY' : r.brain.mood === 'wait' ? 'ARMED' : 'IDLE';
      return `<tr class="clickable ${r.symbol === state.bestSymbol ? 'top' : ''}" data-symbol="${r.symbol}">
        <td class="num rank">#${k + 1}</td>
        <td>${esc(r.name)}${r.symbol === state.symbol ? ' <span class="viewing">VIEWING</span>' : ''}</td>
        <td><div class="signal"><i style="width:${((r.smooth / 3) * 100).toFixed(0)}%"></i></div><span class="num">${pct(r.smooth / 3, 0)}</span></td>
        <td>${b ? `${esc(b.group)} → <b>${esc(b.side)}</b> <span class="muted">· ${esc(b.contract.label)}</span>` : '–'}</td>
        <td class="num">${r.price}</td>
        <td><span class="state ${r.brain.mood}">${status}</span></td>
      </tr>`;
    })
    .join('');
  for (const tr of $('scan-body').querySelectorAll('tr[data-symbol]')) {
    tr.onclick = () => {
      switchMarket(tr.dataset.symbol);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  }
  if (ranked.length) {
    pickBest(ranked);
    autopilotTick(ranked);
  }
}

// Choose the best volatility with hysteresis: a challenger must beat the current pick's
// smoothed score by a margin, and a pick is held at least 15s, so it doesn't flicker.
function pickBest(allRanked) {
  // Markets the risk guard has cooled are skipped while any other market is available.
  const warm = allRanked.filter((r) => !isCold(r.symbol));
  const ranked = warm.length ? warm : allRanked;
  const top = ranked[0];
  const cur = ranked.find((r) => r.symbol === state.bestSymbol);
  const held = state.bestSince ? Date.now() - state.bestSince.getTime() : Infinity;
  const changed = !cur || (top.symbol !== cur.symbol && top.smooth > cur.smooth + 0.15 && held > 15_000);
  if (changed) {
    state.bestSymbol = top.symbol;
    state.bestSince = new Date();
    const b = top.brain.best;
    addThoughts([`Best volatility now: ${top.name}${b ? ` — ${b.group} ${b.side}` : ''} (signal ${pct(top.smooth / 3, 0)})`]);
    speak(`Best volatility: ${top.name.replace('(1s)', 'one second')}. ${b ? `${b.group.replace(' / ', ' or ')}, ${b.side.toLowerCase()}.` : ''}`);
  }
  renderBest(ranked);
}

function renderBest(ranked) {
  const best = ranked.find((r) => r.symbol === state.bestSymbol) ?? ranked[0];
  const b = best.brain.best;
  const card = $('best-vol');
  card.className = `best-vol ${best.brain.mood}`;
  $('bv-name').textContent = best.name;
  $('bv-trade').innerHTML = b
    ? `${esc(b.group)} → <b>${esc(b.side)}</b> · ${esc(b.contract.label)}<small>${b.ready ? 'Entry triggered — trade now' : b.setupOk ? `Setup armed — wait for: ${esc(b.entry?.label ?? 'entry')}` : 'Building setup — not ready yet'}</small>`
    : 'No setup';
  $('bv-meter').style.width = `${((best.smooth / 3) * 100).toFixed(0)}%`;
  $('bv-strength').textContent = `${pct(best.smooth / 3, 0)} signal strength · top pick since ${state.bestSince?.toLocaleTimeString() ?? '–'}`;
  $('bv-reasons').innerHTML = best.brain.reasons.map((r) => `<li>${esc(r)}</li>`).join('');
  $('bv-runners').innerHTML = ranked
    .filter((r) => r.symbol !== best.symbol)
    .slice(0, 3)
    .map((r, k) => `<button type="button" data-symbol="${r.symbol}">#${k + 2} ${esc(shortName(r.symbol))} <span>${pct(r.smooth / 3, 0)}</span></button>`)
    .join('');
  for (const btn of $('bv-runners').querySelectorAll('button')) btn.onclick = () => switchMarket(btn.dataset.symbol);
  $('lock-on').disabled = best.symbol === state.symbol;
  $('lock-on').textContent = best.symbol === state.symbol ? 'Locked on' : `Lock on ${shortName(best.symbol)}`;
}

// ---------- robot memory: paper trading ----------

// Open a simulated trade the moment a strategy turns READY on a scanned market.
function openPaperTrades(symbol, m, results) {
  for (const [id, r] of Object.entries(results)) {
    const key = `${symbol}|${id}`;
    if (!r.ready) { state.paperWasReady.delete(key); continue; }
    if (state.paperWasReady.has(key) || state.paperOpen.has(key)) continue;
    state.paperWasReady.add(key);
    state.paperOpen.set(key, {
      symbol, id, contract: r.contract, baseline: r.baseline, pip: m.pip,
      entryQuote: m.quotes[m.quotes.length - 1], ticksLeft: r.contract.duration,
    });
  }
}

// Each new tick on a market moves its open paper trades one tick closer to settlement.
function settlePaper(symbol, m) {
  const ap = state.autopilot.paperOpen;
  if (ap && ap.symbol === symbol && --ap.ticksLeft <= 0) {
    state.autopilot.paperOpen = null;
    settlePaperAuto(ap, wins(ap.contract, ap.entryQuote, m.quotes[m.quotes.length - 1], ap.pip));
  }
  let settled = false;
  for (const [key, t] of state.paperOpen) {
    if (t.symbol !== symbol || --t.ticksLeft > 0) continue;
    const won = wins(t.contract, t.entryQuote, m.quotes[m.quotes.length - 1], t.pip);
    recordPaper(state.memory, { id: t.id, won, baseline: t.baseline, symbol });
    state.paperOpen.delete(key);
    settled = true;
  }
  if (settled) saveMemorySoon();
}

let memoryTimer = null;
function saveMemorySoon() {
  if (memoryTimer) return;
  memoryTimer = setTimeout(() => { memoryTimer = null; saveJson('memory', state.memory); }, 3000);
}

// ---------- risk guard ----------

// Settings live in the Risk limits inputs; DEFAULT_RISK fills anything left blank.
function riskSettings() {
  const n = (id, fallback) => { const v = Number($(id).value); return $(id).value !== '' && Number.isFinite(v) ? v : fallback; };
  return {
    ...DEFAULT_RISK,
    maxStreak: Math.max(1, Math.round(n('risk-max', DEFAULT_RISK.maxStreak))),
    coolMin: Math.max(1, n('risk-cool', DEFAULT_RISK.coolMin)),
    stopLoss: n('risk-sl', null),
    takeProfit: n('risk-tp', null),
    maxTrades: Math.max(1, Math.round(n('risk-trades', DEFAULT_RISK.maxTrades))),
    maxStakePct: Math.max(0.1, n('risk-pct', DEFAULT_RISK.maxStakePct)),
    recovery: $('risk-recovery').value,
    strict: $('risk-strict').checked,
    sizing: $('risk-sizing').value,
    stakePct: Math.max(0.1, n('risk-stakepct', DEFAULT_RISK.stakePct)),
  };
}
const riskMax = () => riskSettings().maxStreak;
// Paper account: a starting balance (default 10) moved by every paper trade's real-payout profit.
const paperStart = () => Math.max(0, Number(store.get('paper.start', '10')) || 0);
const paperBalance = () => Math.round((paperStart() + state.history.reduce((s, h) => (h.acct === 'paper' ? s + h.profit : s), 0)) * 100) / 100;
const currentBalance = () => (state.account ? state.balance : paperBalance());

// Base stake: the fixed stake box, or (compound mode) a % of the current balance, never below Deriv's minimum.
function baseStake() {
  const settings = riskSettings();
  if (settings.sizing === 'compound') return compoundStake(currentBalance(), settings.stakePct);
  return Math.max(0, Number($('stake').value) || 0);
}
const stakeNow = () => nextStake(baseStake(), riskSettings(), state.session);
// A strategy's own stake (set on its card) replaces the base stake; recovery still applies.
function stakeFor(strategyId) {
  const own = Number(store.get(`strat.${strategyId}.stake`, ''));
  return own > 0 ? nextStake(own, riskSettings(), state.session) : stakeNow();
}
const riskLocked = () => state.risk.lockedUntil > Date.now();
const isCold = (symbol) => (state.risk.cold[symbol] ?? 0) > Date.now();
// A strategy's verdict on a given market: that market's replay pooled with robot memory.
function strategyVerdict(id, symbol = state.symbol) {
  const replay = symbol === state.symbol ? state.records[id] : state.scanRecords.get(symbol)?.records[id];
  return verdictOf(combineRecords(replay, memoryRecord(state.memory, id))).cls;
}

// Everything that would block the next trade on this strategy and market.
function tradeBlockers(strategyId, symbol = state.symbol) {
  const s = STRATEGIES.find((x) => x.id === strategyId);
  if (s && !strategyAllowed(s, symbol)) return [`${s.group} isn't offered on ${entryOf(symbol)?.name ?? symbol}`];
  return preTradeCheck({
    stake: stakeFor(strategyId),
    base: baseStake(),
    settings: riskSettings(),
    session: state.session,
    balance: state.balance,
    verdict: strategyVerdict(strategyId, symbol),
    locked: riskLocked(),
  });
}

const recordRealOutcome = (symbol, won, profit) => recordOutcome(symbol, won, profit, false);

// Apply a settled trade to the loss-streak lock and session limits. Paper trades
// keep their own copy (paperRisk / paperSession) so practice never locks real trading.
function recordOutcome(symbol, won, profit, paper) {
  const settings = riskSettings();
  const r = paper ? state.paperRisk : state.risk;
  const session = paper ? state.paperSession : state.session;
  const tag = paper ? 'PAPER ' : '';
  if (won) r.lossStreak = 0;
  else r.lossStreak++;
  if (!won && r.lossStreak >= settings.maxStreak) {
    r.lockedUntil = Date.now() + settings.coolMin * 60_000;
    r.cold[symbol] = r.lockedUntil;
    r.lossStreak = 0;
    const until = new Date(r.lockedUntil).toLocaleTimeString();
    addThoughts([`${tag}RISK GUARD: ${settings.maxStreak} losses in a row — trading locked until ${until}, avoiding ${nameOf(symbol)}`]);
    speak(`${paper ? 'Paper ' : ''}risk guard engaged. ${settings.maxStreak} losses in a row. Cooling down.`);
    if (!paper && state.autoRotate && symbol === state.symbol) rotate();
  }
  const events = applyOutcome(session, settings, baseStake(), { won, profit });
  if (events.includes('cycle-capped')) addThoughts([`${tag}Loss cap: ${settings.maxSteps} losses in this recovery cycle — stake reset to base`]);
  if (session.ended) {
    addThoughts([`${tag}SESSION OVER: ${session.ended}. Trading stopped.`]);
    speak(`${paper ? 'Paper session' : 'Session'} over. ${events.includes('take-profit') ? 'Target reached. Well done, stop here.' : 'Limit reached. Stop for now.'}`);
  }
  saveJson(paper ? 'paperRisk' : 'risk', r);
  saveJson(paper ? 'paperSession' : 'session', session);
  renderRisk();
  renderCards();
}

function renderRisk() {
  const r = state.risk;
  const settings = riskSettings();
  const s = state.session;
  const base = baseStake();
  const cur = state.account?.currency ?? '';
  const el = $('risk-state');
  const max = settings.maxStreak;
  if (s.ended) {
    el.className = 'risk-state locked';
    el.innerHTML = `<b>SESSION OVER</b><span>${esc(s.ended)}. Trading is off until you start a new session — ideally tomorrow.</span>`;
  } else if (riskLocked()) {
    const left = Math.ceil((r.lockedUntil - Date.now()) / 1000);
    el.className = 'risk-state locked';
    el.innerHTML = `<b>LOCKED · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</b><span>${max} losses in a row hit. Trade buttons are off until the cooldown ends. Step away.</span>`;
  } else {
    el.className = `risk-state ${r.lossStreak >= max - 1 && r.lossStreak > 0 ? 'warn' : 'armed'}`;
    el.innerHTML = `<b>ARMED · ${r.lossStreak}/${max}</b><span>Losses in a row. At ${max} the guard locks trading for ${settings.coolMin} min and moves the robot off that market.</span>`;
  }
  const cold = Object.entries(r.cold).filter(([, t]) => t > Date.now()).map(([sym]) => shortName(sym));
  if (cold.length) el.innerHTML += `<span> Cooling: ${esc(cold.join(', '))}</span>`;

  const sl = stopLossAmount(base, settings);
  const budget = Math.max(0, sl + s.pnl);
  $('risk-sl-hint').textContent = settings.stopLoss > 0 ? '' : `auto = ${num(sl)} (one worst-case cycle)`;
  $('session-stats').innerHTML = `
    <div class="stat"><span>Session P&amp;L</span><b class="${s.pnl > 0 ? 'up' : s.pnl < 0 ? 'down' : ''}" style="color:${s.pnl > 0 ? 'var(--green)' : s.pnl < 0 ? 'var(--red)' : 'inherit'}">${s.pnl > 0 ? '+' : ''}${num(s.pnl)} ${esc(cur)}</b></div>
    <div class="stat"><span>Won / lost</span><b>${s.wins} / ${s.losses}</b></div>
    <div class="stat"><span>Trades used</span><b>${s.trades} / ${settings.maxTrades}</b></div>
    <div class="stat"><span>Loss budget left</span><b>${num(budget)} ${esc(cur)}</b></div>
    <div class="stat"><span>Next stake</span><b>${num(stakeNow())}${settings.recovery === 'martingale' ? ` · step ${s.step + 1}/${settings.maxSteps}` : ''}</b></div>
    <div class="stat"><span>Started</span><b>${new Date(s.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b></div>`;

  const worst = worstCase(base, settings);
  const cycleText = settings.recovery === 'martingale'
    ? `A recovery cycle risks <b>${num(base)}</b> then <b>${num(base * settings.multiplier)}</b> — at most <b>${settings.maxSteps} losses = −${num(worst)}</b>, then the stake resets.`
    : `Each trade risks only its stake, <b>−${num(base)}</b>. ${max} losses in a row = <b>−${num(worst)}</b>, then the lock.`;
  $('risk-worst').innerHTML = `
    <div>${cycleText}</div>
    <div>Session stop-loss: trading stops at <b>−${num(sl)}</b>${settings.takeProfit > 0 ? `; take-profit stops you at <span class="ok"><b>+${num(settings.takeProfit)}</b></span>` : ''}.</div>
    <div>Biggest single stake allowed: <b>${settings.maxStakePct}%</b> of balance${state.balance > 0 ? ` = ${num((state.balance * settings.maxStakePct) / 100)} ${esc(cur)}` : ''}.</div>`;
  renderTicketButton();

  // The honest arithmetic: how often a run of `max` losses shows up at the robot's live win rate.
  const mem = state.memory;
  const p = mem.total >= 20 ? mem.wins / mem.total : 0.5;
  const q = 1 - p;
  const every = expectedTradesUntilStreak(q, max);
  $('risk-odds').innerHTML = `At a <b>${pct(p, 0)}</b> win rate${mem.total >= 20 ? ' (robot memory)' : ' (coin flip)'}, ${max} losses in a row happen on average every <b>${Number.isFinite(every) ? Math.round(every) : '∞'}</b> trades. Chance within your next ${settings.maxTrades} trades: <b>${pct(streakChance(q, max, settings.maxTrades), 0)}</b>. Losses can't be avoided — these limits cap what they cost.`;
}

// ---------- knowledge core: learning from sites ----------

function applyLearned() {
  const compiled = [];
  for (const item of state.learned) {
    if (!item.enabled) continue;
    try { compiled.push(compileStrategy(item.spec, item.source)); } catch (err) { console.warn('learned strategy skipped:', err.message); }
  }
  setLearned(compiled);
  buildCards();
  renderBotStrategies();
  state.scanRecords.clear();
  scheduleBacktests();
  renderLearning();
}

async function learnFromSource(e) {
  e.preventDefault();
  const url = $('learn-url').value.trim();
  const text = $('learn-text').value.trim();
  const status = $('learn-status');
  if (!url && !text) { status.className = 'learn-status err'; status.textContent = 'Give a link or paste some text first.'; return; }
  $('learn-btn').disabled = true;
  status.className = 'learn-status busy';
  status.textContent = `Reading ${url ? new URL(url, location.href).hostname : 'pasted text'} and extracting rules… (can take a minute)`;
  addThoughts([`Learning from ${url || 'pasted text'}`]);
  try {
    const res = await fetch('/api/learn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(url ? { url } : { text }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    let added = 0;
    for (const spec of data.strategies) {
      try {
        const compiled = compileStrategy(spec, data.source);
        state.learned = state.learned.filter((x) => compileStrategy(x.spec, x.source).id !== compiled.id);
        state.learned.push({ spec, source: data.source, learnedAt: Date.now(), enabled: true, unsupported: spec.unsupported_rules });
        added++;
      } catch (err) { console.warn('could not compile', spec.name, err.message); }
    }
    saveJson('learned', state.learned);
    applyLearned();
    status.className = `learn-status ${added ? 'ok' : 'err'}`;
    status.textContent = added
      ? `Learned ${added} strateg${added === 1 ? 'y' : 'ies'} from "${data.source.title}". Replaying them on real ticks now.${data.truncated ? ' (Page was very long — only the first part was read.)' : ''}${data.notes ? ` Notes: ${data.notes}` : ''}`
      : `No testable rules found in "${data.source.title}". ${data.notes ?? ''}`;
    addThoughts([added ? `Learned ${added} new strateg${added === 1 ? 'y' : 'ies'} — verifying against real ticks` : 'Source had no testable rules — nothing learned']);
    if (added) speak(`Knowledge acquired. ${added} new strateg${added === 1 ? 'y' : 'ies'}. Verifying.`);
    $('learn-url').value = '';
    $('learn-text').value = '';
  } catch (err) {
    status.className = 'learn-status err';
    status.textContent = err.message;
  } finally {
    $('learn-btn').disabled = false;
  }
}

function verdictOf(rec) {
  if (!rec?.trades || rec.trades < 20) return { cls: 'unproven', text: `UNPROVEN · ${rec?.trades ?? 0} trades` };
  if (rec.ci[0] > rec.baseline) return { cls: 'proven', text: 'PROVEN EDGE' };
  if (rec.ci[1] < rec.baseline) return { cls: 'rejected', text: 'REJECTED' };
  return { cls: 'unproven', text: 'NO EDGE YET' };
}

function renderLearning() {
  const combined = withMemory(state.records);
  // Built-in strategies that came from a website's description (no rule file to toggle or forget).
  const fromSites = STRATEGIES.filter((s) => s.source && !s.learned)
    .map((s) => {
      const rec = combined[s.id];
      const v = verdictOf(rec);
      return `<li class="learned ${v.cls}">
        <div class="learned-top"><b>${esc(s.name)}</b><span class="verdict ${v.cls}">${v.text}</span></div>
        <small>${esc(s.group)} · built in from the site's public description</small>
        <small><a href="${esc(s.source.url)}" target="_blank" rel="noopener noreferrer">${esc(s.source.title)}</a>${rec?.trades ? ` · ${pct(rec.winRate)} win vs ${pct(rec.baseline, 0)} chance over ${rec.trades}` : ''}</small>
      </li>`;
    })
    .join('');
  // Knowledge list
  $('learned-list').innerHTML = fromSites + (state.learned.length
    ? state.learned
        .map((item, k) => {
          let id = '';
          try { id = compileStrategy(item.spec, item.source).id; } catch { /* invalid spec */ }
          const v = verdictOf(combined[id]);
          const rec = combined[id];
          const sides = item.spec.sides.map((s) => `${s.side}: ${s.conditions.length} rule${s.conditions.length === 1 ? '' : 's'}`).join(' · ');
          return `<li class="learned ${item.enabled ? v.cls : ''}">
            <div class="learned-top"><b>${esc(item.spec.name)}</b><span class="verdict ${v.cls}">${item.enabled ? v.text : 'OFF'}</span></div>
            <small>${esc(item.spec.group)} · ${esc(sides)} · entry ${esc(item.spec.entry.replace(/_/g, ' '))}</small>
            <small>${item.source?.url ? `<a href="${esc(item.source.url)}" target="_blank" rel="noopener noreferrer">${esc(item.source.title)}</a>` : esc(item.source?.title ?? 'Pasted text')}${rec?.trades ? ` · ${pct(rec.winRate)} win vs ${pct(rec.baseline, 0)} chance over ${rec.trades}` : ''}</small>
            ${item.unsupported?.length ? `<div class="unsupported">Couldn't encode: ${esc(item.unsupported.join('; '))}</div>` : ''}
            <div class="learned-actions">
              <label class="toggle"><input type="checkbox" data-toggle="${k}" ${item.enabled ? 'checked' : ''}> Active</label>
              <button type="button" class="ghost" data-forget="${k}">Forget</button>
            </div>
          </li>`;
        })
        .join('')
    : fromSites ? '' : '<li class="muted">Nothing learned yet. Paste a strategy link above.</li>');

  // Memory
  const mem = state.memory;
  $('memory-stats').innerHTML = `
    <div class="stat"><span>Paper trades learned</span><b>${mem.total}</b></div>
    <div class="stat"><span>Live win rate</span><b>${mem.total ? pct(mem.wins / mem.total) : '–'}</b></div>
    <div class="stat"><span>Loss streak now</span><b>${mem.lossStreak}</b></div>
    <div class="stat"><span>Longest loss streak</span><b>${mem.maxLossStreak}</b></div>`;
  $('memory-recent').innerHTML = mem.recent.slice(0, 40).map((t) => `<i class="${t.won ? 'w' : 'l'}" title="${esc(shortName(t.symbol))} ${t.won ? 'win' : 'loss'}"></i>`).join('');
  const names = Object.fromEntries(STRATEGIES.map((s) => [s.id, `${s.group.split(' ')[0]} · ${s.name.split(' · ')[0]}`]));
  $('memory-table').innerHTML = Object.keys(mem.by)
    .map((id) => ({ id, rec: memoryRecord(mem, id) }))
    .sort((a, b) => b.rec.trades - a.rec.trades)
    .slice(0, 8)
    .map(({ id, rec }) => `<li><span>${esc(names[id] ?? id)}</span><span class="trust">trust ×${edgeFactor(combined[id] ?? rec).toFixed(2)}</span><small>${rec.wins}/${rec.trades} won · ${pct(rec.winRate, 0)} vs ${pct(rec.baseline, 0)} chance</small></li>`)
    .join('') || '<li class="muted">Learning… paper trades appear as strategies fire.</li>';

  renderRisk();
}

function initLearning() {
  $('learn-form').onsubmit = learnFromSource;
  $('learned-list').onclick = (e) => {
    const t = e.target;
    if (t.dataset.forget !== undefined) {
      state.learned.splice(Number(t.dataset.forget), 1);
      saveJson('learned', state.learned);
      applyLearned();
    }
  };
  $('learned-list').onchange = (e) => {
    const t = e.target;
    if (t.dataset.toggle === undefined) return;
    state.learned[Number(t.dataset.toggle)].enabled = t.checked;
    saveJson('learned', state.learned);
    applyLearned();
  };
  $('memory-reset').onclick = () => {
    if (!confirm('Wipe everything the robot has learned from paper trading?')) return;
    state.memory = emptyMemory();
    saveJson('memory', state.memory);
    renderLearning();
  };
  // Risk limits persist per field; the 2-loss defaults apply until changed.
  const riskFields = { 'risk-max': '2', 'risk-cool': '15', 'risk-sl': '', 'risk-tp': '', 'risk-trades': '10', 'risk-pct': '2', 'risk-recovery': 'off', 'risk-sizing': 'fixed', 'risk-stakepct': '5' };
  for (const [id, fallback] of Object.entries(riskFields)) {
    $(id).value = store.get(`risk.${id}`, fallback);
    $(id).onchange = () => { store.set(`risk.${id}`, $(id).value); renderRisk(); renderCards(); };
  }
  $('risk-strict').checked = store.get('risk.strict', '0') === '1';
  $('risk-strict').onchange = () => { store.set('risk.strict', $('risk-strict').checked ? '1' : '0'); renderCards(); };
  $('stake').addEventListener('change', () => renderRisk());
  $('risk-reset').onclick = () => {
    state.risk = { lossStreak: 0, lockedUntil: 0, cold: {} };
    saveJson('risk', state.risk);
    renderRisk();
    renderCards();
  };
  $('session-new').onclick = () => {
    if (state.session.trades && !confirm(`Close this session (${state.session.pnl > 0 ? '+' : ''}${num(state.session.pnl)}) and start a new one?`)) return;
    state.session = newSession();
    saveJson('session', state.session);
    addThoughts(['New trading session started — limits reset']);
    renderRisk();
    renderCards();
  };
  applyLearned();
  window.addEventListener('beforeunload', () => saveJson('memory', state.memory));
}

// ---------- autopilot: scan every market and trade by itself ----------

function autopilotSettings() {
  return {
    groups: [...document.querySelectorAll('#ap-groups input:checked')].map((i) => i.value),
    minStrength: Number($('ap-min').value) / 100,
    gapSec: Math.max(3, Number($('ap-gap').value) || DEFAULT_AUTOPILOT.gapSec),
  };
}

function apLog(text, cls = '') {
  const ap = state.autopilot;
  ap.log.unshift({ time: new Date().toLocaleTimeString(), text, cls });
  ap.log.length = Math.min(ap.log.length, 14);
  addThoughts([`AUTOPILOT: ${text}`]);
}

async function engageAutopilot() {
  const ap = state.autopilot;
  const acct = state.account;
  const mode = !acct ? 'paper' : acct.account_type === 'demo' ? 'demo' : 'real';
  if (mode === 'paper' && state.paperSession.ended) {
    // Paper is practice: offer a fresh paper session instead of blocking.
    if (!confirm(`Your last paper session ended (${state.paperSession.ended}). Start a new paper session?`)) return;
    state.paperSession = newSession();
    state.paperRisk = { lossStreak: 0, lockedUntil: 0, cold: {} };
    saveJson('paperSession', state.paperSession);
    saveJson('paperRisk', state.paperRisk);
  }
  if (mode !== 'paper' && state.session.ended) return alert(`Your session has ended (${state.session.ended}). Start a new session in the Risk panel first.`);
  const settings = riskSettings();
  const sl = stopLossAmount(baseStake(), settings);
  if (mode === 'real') {
    const typed = prompt(`Autopilot will place REAL-MONEY trades on ${acct.account_id} by itself, without asking each time.\n\nYour limits still apply: stop-loss −${num(sl)} ${acct.currency}, lock after ${settings.maxStreak} losses in a row, max ${settings.maxTrades} trades.\n\nType REAL to confirm.`);
    if (typed?.trim().toUpperCase() !== 'REAL') return;
  } else if (mode === 'demo' && !confirm(`Autopilot will place trades on your DEMO account ${acct.account_id} automatically. Continue?`)) {
    return;
  }
  if (!state.scanning) startScanner();
  Object.assign(ap, { on: true, mode, busy: false, lastTradeAt: 0, status: 'Scanning…', paperOpen: null, run: { trades: 0, wins: 0, losses: 0, pnl: 0 } });
  apLog(`Engaged in ${mode.toUpperCase()} mode — scanning ${scanSymbols().length} markets`, 'on');
  speak(`Autopilot engaged. ${mode} mode.`);
  renderAutopilot();
}

function haltAutopilot(reason) {
  const ap = state.autopilot;
  if (!ap.on) return;
  ap.on = false;
  ap.status = `Stopped: ${reason}`;
  apLog(`Stopped — ${reason}`, 'off');
  speak('Autopilot stopped.');
  renderAutopilot();
}

// Paper mode applies every rule except the % of balance cap, against its own session and lock.
function paperBlockers(id, symbol) {
  const balance = paperBalance();
  if (balance < MIN_STAKE) return [`Paper account is down to ${num(balance)} — below Deriv's ${MIN_STAKE} minimum stake. Reset it in Grow my account`];
  return preTradeCheck({
    stake: stakeFor(id), base: baseStake(), settings: riskSettings(),
    session: state.paperSession, balance, verdict: strategyVerdict(id, symbol),
    locked: state.paperRisk.lockedUntil > Date.now(),
  });
}

// Value a settled paper trade with Deriv's real payout quote, then record it like a real one.
async function settlePaperAuto(open, won) {
  let payout = open.payout;
  if (payout == null) payout = await open.payoutPromise.catch(() => null);
  const profit = payout ? profitOf(won, open.stake, payout) : (won ? 0 : -open.stake);
  recordOutcome(open.symbol, won, profit, true);
  recordHistory({
    t: Date.now(), symbol: open.symbol, stake: open.stake, profit, won, auto: true,
    contract: open.contract.label, type: open.contract.contract_type,
    strategyId: open.strategyId, strategyName: open.strategyName, group: open.group,
    acct: 'paper', accountId: 'paper', currency: state.account?.currency ?? 'USD',
  });
  finishAutoTrade(won, profit);
}

// Called after every self-scan sweep with the freshly ranked markets.
function autopilotTick(ranked) {
  const ap = state.autopilot;
  if (!ap.on) return;
  const session = ap.mode === 'paper' ? state.paperSession : state.session;
  if (session.ended) return haltAutopilot(`${ap.mode === 'paper' ? 'paper ' : ''}session ${session.ended}`);
  const res = pickAutoTrade(ranked, autopilotSettings(), { now: Date.now(), lastTradeAt: ap.lastTradeAt, busy: ap.busy },
    (id, symbol) => {
      if (store.get(`strat.${id}.bot`, '1') !== '1') return ['switched off for Autopilot on its card'];
      const s = STRATEGIES.find((x) => x.id === id);
      if (s && !strategyAllowed(s, symbol)) return [`${s.group} isn't offered on ${entryOf(symbol)?.name ?? symbol}`];
      return ap.mode === 'paper' ? paperBlockers(id, symbol) : tradeBlockers(id, symbol);
    });
  if (res.skip) {
    ap.status = res.skip;
    renderAutopilot();
    return;
  }
  const t = res.trade;
  ap.busy = true;
  ap.lastTradeAt = Date.now();
  ap.status = `In trade: ${shortName(t.symbol)} · ${t.contract.label}`;
  apLog(`${shortName(t.symbol)} · ${t.group} → ${t.side} (${t.contract.label}) · signal ${pct(t.strength, 0)}`, 'trade');
  if (ap.mode === 'paper') {
    const m = state.scanner.get(t.symbol);
    const open = { ...t, pip: m.pip, entryQuote: m.quotes[m.quotes.length - 1], ticksLeft: t.contract.duration, stake: stakeFor(t.strategyId), payout: null };
    // Ask Deriv what this exact contract pays, while the tick plays out.
    open.payoutPromise = payoutPerUnit(client, t.symbol, t.contract);
    open.payoutPromise.then((p) => { open.payout = p; }, () => {});
    ap.paperOpen = open;
  } else {
    executeTrade({ symbol: t.symbol, contract: t.contract, stake: stakeFor(t.strategyId), auto: true, meta: { strategyId: t.strategyId, strategyName: t.strategyName, group: t.group } })
      .then(({ won, profit }) => finishAutoTrade(won, profit))
      .catch((err) => { ap.busy = false; haltAutopilot(`buy failed: ${err.message}`); });
  }
  renderAutopilot();
}

function finishAutoTrade(won, profit) {
  const ap = state.autopilot;
  ap.busy = false;
  ap.run.trades++;
  won ? ap.run.wins++ : ap.run.losses++;
  ap.run.pnl = Math.round((ap.run.pnl + profit) * 100) / 100;
  apLog(`${won ? 'WON' : 'LOST'} ${profit > 0 ? '+' : ''}${num(profit)}${ap.mode === 'paper' ? ' (paper)' : ''} · run ${ap.run.pnl > 0 ? '+' : ''}${num(ap.run.pnl)}`, won ? 'won' : 'lost');
  renderAutopilot();
}

function renderAutopilot() {
  const ap = state.autopilot;
  const btn = $('ap-toggle');
  btn.textContent = ap.on ? 'STOP AUTOPILOT' : 'ENGAGE AUTOPILOT';
  btn.className = ap.on ? 'ap-stop' : 'ap-go';
  const mode = ap.on ? ap.mode : !state.account ? 'paper' : state.account.account_type === 'demo' ? 'demo' : 'real';
  $('ap-mode').textContent = mode.toUpperCase();
  $('ap-mode').className = `pill ap-mode ${mode}`;
  $('ap-panel').classList.toggle('engaged', ap.on);
  $('ap-status').textContent = ap.on ? ap.status : ap.status || 'Off — press Engage to let the robot trade by itself';
  const r = ap.run;
  $('ap-stats').innerHTML = `
    <div class="stat"><span>Auto trades</span><b>${r.trades}</b></div>
    <div class="stat"><span>Won / lost</span><b>${r.wins} / ${r.losses}</b></div>
    <div class="stat"><span>Win rate</span><b>${r.trades ? pct(r.wins / r.trades, 0) : '–'}</b></div>
    <div class="stat"><span>Earned this run${ap.mode === 'paper' ? ' (paper)' : ''}</span><b style="color:${r.pnl > 0 ? 'var(--green)' : r.pnl < 0 ? 'var(--red)' : 'inherit'}">${r.pnl > 0 ? '+' : ''}${num(r.pnl)} ${esc(state.account?.currency ?? 'USD')}</b></div>`;
  $('ap-log').innerHTML = ap.log.map((l) => `<li class="${l.cls}"><time>${l.time}</time>${esc(l.text)}</li>`).join('') || '<li class="muted">No autopilot activity yet.</li>';
  renderEarnChip();
}

function initAutopilot() {
  $('ap-groups').innerHTML = AUTOPILOT_GROUPS.map((g) => `<label class="toggle"><input type="checkbox" value="${g}" ${(store.get(`ap.${g}`, '1') === '1') ? 'checked' : ''}> ${g}</label>`).join('');
  $('ap-groups').onchange = (e) => store.set(`ap.${e.target.value}`, e.target.checked ? '1' : '0');
  $('ap-min').value = store.get('ap.min', String(DEFAULT_AUTOPILOT.minStrength * 100));
  $('ap-gap').value = store.get('ap.gap', String(DEFAULT_AUTOPILOT.gapSec));
  const showMin = () => { $('ap-min-val').textContent = `${$('ap-min').value}%`; };
  $('ap-min').oninput = () => { showMin(); store.set('ap.min', $('ap-min').value); };
  $('ap-gap').onchange = () => store.set('ap.gap', $('ap-gap').value);
  showMin();
  $('ap-toggle').onclick = () => (state.autopilot.on ? haltAutopilot('stopped by you') : engageAutopilot());
  // Keyboard kill switch.
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.autopilot.on) haltAutopilot('Esc pressed'); });
  // Bot settings are the same settings as the header stake, radar and Risk panel — one value, two places.
  mirror('stake', 'ap-stake');
  mirror('scan-universe', 'ap-universe');
  mirror('risk-recovery', 'ap-recovery');
  mirror('risk-sl', 'ap-sl');
  mirror('risk-tp', 'ap-tp');
  mirror('risk-trades', 'ap-trades');
  mirror('risk-max', 'ap-streak');
  mirror('risk-sizing', 'ap-sizing');
  mirror('risk-stakepct', 'ap-stakepct');
  mirror('risk-pct', 'ap-maxpct');
  $('ap-strats').onchange = (e) => {
    const t = e.target;
    const id = t.dataset.id;
    if (!id) return;
    if (t.type === 'checkbox') store.set(`strat.${id}.bot`, t.checked ? '1' : '0');
    else store.set(`strat.${id}.stake`, t.value);
    // Keep the strategy card's own controls in step.
    const card = cards[id]?.el;
    if (card) {
      card.querySelector('.bot-allow').checked = store.get(`strat.${id}.bot`, '1') === '1';
      card.querySelector('.strat-stake').value = store.get(`strat.${id}.stake`, '');
    }
    renderBotStrategies();
    renderCards();
  };
  renderBotStrategies();
  renderAutopilot();
}

// Show `src`'s value in `copy` too, and write edits in `copy` back through `src`'s own handlers.
function mirror(src, copy) {
  $(copy).value = $(src).value;
  $(copy).addEventListener('change', () => {
    $(src).value = $(copy).value;
    $(src).dispatchEvent(new Event('change'));
  });
  $(src).addEventListener('change', () => { if ($(copy).value !== $(src).value) $(copy).value = $(src).value; });
}

// Every strategy, with whether the bot may use it and its own stake.
function renderBotStrategies() {
  const rows = STRATEGIES.map((s) => {
    const on = store.get(`strat.${s.id}.bot`, '1') === '1';
    return `<tr>
      <td><input type="checkbox" data-id="${esc(s.id)}" ${on ? 'checked' : ''} aria-label="Autopilot may use ${esc(s.name)}"></td>
      <td>${esc(s.name.split(' · ')[0])}<div class="grp">${esc(s.group)}${s.learned ? ' · learned' : ''}</div></td>
      <td><input type="number" min="0.35" step="0.01" data-id="${esc(s.id)}" value="${esc(store.get(`strat.${s.id}.stake`, ''))}" placeholder="stake" aria-label="Own stake for ${esc(s.name)}"></td>
    </tr>`;
  });
  $('ap-strats').innerHTML = rows.join('');
  const enabled = STRATEGIES.filter((s) => store.get(`strat.${s.id}.bot`, '1') === '1').length;
  $('ap-strats-count').textContent = `(${enabled} of ${STRATEGIES.length} on)`;
}

// ---------- earnings: what is (and isn't) making money ----------

const GROUP_OF_TYPE = {
  CALL: 'Rise / Fall', PUT: 'Rise / Fall', DIGITEVEN: 'Even / Odd', DIGITODD: 'Even / Odd',
  DIGITOVER: 'Over / Under', DIGITUNDER: 'Over / Under', DIGITMATCH: 'Matches / Differs', DIGITDIFF: 'Matches / Differs',
};
const groupOfType = (type) => GROUP_OF_TYPE[type] ?? type;

function recordHistory(item) {
  state.history.push(item);
  if (state.history.length > 3000) state.history.splice(0, state.history.length - 3000);
  saveJson('history', state.history);
  renderEarnings();
  scheduleGrowth();
}

function earningsSince(period) {
  const now = new Date();
  if (period === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (period === '7d') return Date.now() - 7 * 86_400_000;
  if (period === '30d') return Date.now() - 30 * 86_400_000;
  return 0;
}

function renderEarnings() {
  const list = filterHistory(state.history, { acct: $('earn-acct').value, since: earningsSince($('earn-period').value) });
  const s = summarize(list);
  const cur = list[0]?.currency ?? state.account?.currency ?? '';
  const signed = (x) => `${x > 0 ? '+' : ''}${num(x)}`;
  const cls = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : '');
  $('earn-kpis').innerHTML = `
    <div class="stat"><span>Net profit / loss</span><b class="${cls(s.net)}">${signed(s.net)} ${esc(cur)}</b></div>
    <div class="stat"><span>Trades</span><b>${s.trades}</b></div>
    <div class="stat"><span>Win rate</span><b>${pct(s.winRate, 1)}</b></div>
    <div class="stat"><span>Return on stakes</span><b class="${cls(s.roi)}">${pct(s.roi, 1)}</b></div>
    <div class="stat"><span>Avg win / avg loss</span><b>${signed(s.avgWin)} / ${num(s.avgLoss)}</b></div>
    <div class="stat"><span>Worst drawdown</span><b class="${s.maxDrawdown ? 'down' : ''}">${s.maxDrawdown ? `−${num(s.maxDrawdown)}` : '0.00'}</b></div>`;
  const table = (id, rows) => {
    $(id).innerHTML = rows.length
      ? `<thead><tr><th></th><th>Trades</th><th>Win</th><th>P&amp;L</th></tr></thead><tbody>${rows.slice(0, 8)
        .map((r) => `<tr><td>${esc(r.key === r.label && SYMBOLS.some((x) => x.symbol === r.key) ? shortName(r.key) : r.label)}</td><td class="num">${r.trades}</td><td class="num">${pct(r.winRate, 0)}</td><td class="num ${cls(r.pnl)}">${signed(r.pnl)}</td></tr>`)
        .join('')}</tbody>`
      : '<tbody><tr><td class="muted">No trades yet.</td></tr></tbody>';
  };
  table('earn-market', s.byMarket);
  table('earn-strategy', s.byStrategy);
  table('earn-type', s.byType);
  table('earn-who', s.autoVsManual);
  drawEquityCurve(s.curve);
  renderEarnChip();
}

// Header chip: today's earnings for the account in use (paper when none is linked).
function renderEarnChip() {
  const acct = state.account?.account_type ?? 'paper';
  const today = summarize(filterHistory(state.history, { acct, since: earningsSince('today') }));
  const chip = $('earn-chip');
  chip.className = `earn-chip ${today.net > 0 ? 'up' : today.net < 0 ? 'down' : ''}`;
  $('earn-chip-acct').textContent = acct.toUpperCase();
  $('earn-chip-value').textContent = `${today.net > 0 ? '+' : ''}${num(today.net)} ${state.account?.currency ?? 'USD'}`;
  chip.title = `${today.trades} trades today · ${pct(today.winRate, 0)} won — click for the full breakdown`;
}

function drawEquityCurve(curve) {
  const canvas = $('earn-curve');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 300, H = 170;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  ctx.font = '11px JetBrains Mono, monospace';
  if (curve.length < 2) {
    ctx.fillStyle = cssVar('--muted');
    ctx.fillText('The curve appears after your first trades.', 10, H / 2);
    return;
  }
  const values = [0, ...curve.map((p) => p.equity)];
  const lo = Math.min(...values), hi = Math.max(...values);
  const pad = (hi - lo) * 0.1 || 1;
  const y = (v) => 8 + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 16);
  const x = (k) => 6 + (k / (values.length - 1)) * (W - 12);
  ctx.strokeStyle = cssVar('--line');
  ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(W, y(0)); ctx.stroke();
  ctx.setLineDash([]);
  const last = values[values.length - 1];
  ctx.strokeStyle = last >= 0 ? cssVar('--green') : cssVar('--red');
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((v, k) => (k ? ctx.lineTo(x(k), y(v)) : ctx.moveTo(x(k), y(v))));
  ctx.stroke();
  ctx.fillStyle = cssVar('--muted');
  ctx.fillText(`${last > 0 ? '+' : ''}${last.toFixed(2)}`, W - 70, y(last) - 6);
}

function downloadCsv() {
  const list = filterHistory(state.history, { acct: $('earn-acct').value, since: earningsSince($('earn-period').value) });
  const blob = new Blob([toCsv(list)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `stinchez-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function initEarnings() {
  $('earn-acct').value = store.get('earn.acct', 'paper');
  $('earn-period').value = store.get('earn.period', 'today');
  $('earn-acct').onchange = () => { store.set('earn.acct', $('earn-acct').value); renderEarnings(); };
  $('earn-period').onchange = () => { store.set('earn.period', $('earn-period').value); renderEarnings(); };
  $('earn-csv').onclick = downloadCsv;
  $('earn-reset').onclick = () => {
    if (!confirm('Clear all paper (simulated) results and start a fresh paper session? Demo and real trades are kept.')) return;
    state.history = state.history.filter((h) => h.acct !== 'paper');
    state.paperSession = newSession();
    state.paperRisk = { lossStreak: 0, lockedUntil: 0, cold: {} };
    saveJson('history', state.history);
    saveJson('paperSession', state.paperSession);
    saveJson('paperRisk', state.paperRisk);
    renderEarnings();
  };
  renderEarnings();
}

// ---------- grow my account: plan, simulate, apply ----------

// Contract choices for the plan: quote spec, fair chance of winning, and the bot's contract group.
const GROWTH_CONTRACTS = {
  EO: { label: 'Even / Odd', contract: { contract_type: 'DIGITEVEN', duration: 1 }, fair: 0.5, group: 'Even / Odd', types: ['DIGITEVEN', 'DIGITODD'] },
  RF: { label: 'Rise / Fall', contract: { contract_type: 'CALL', duration: 5 }, fair: 0.5, group: 'Rise / Fall', types: ['CALL', 'PUT'] },
  OVER2: { label: 'Over 2', contract: { contract_type: 'DIGITOVER', barrier: 2, duration: 1 }, fair: 0.7, group: 'Over / Under', types: ['DIGITOVER'], prefix: 'Over 2' },
  UNDER7: { label: 'Under 7', contract: { contract_type: 'DIGITUNDER', barrier: 7, duration: 1 }, fair: 0.7, group: 'Over / Under', types: ['DIGITUNDER'], prefix: 'Under 7' },
  DIFFERS: { label: 'Differs', contract: { contract_type: 'DIGITDIFF', barrier: 5, duration: 1 }, fair: 0.9, group: 'Matches / Differs', types: ['DIGITDIFF'] },
  MATCHES: { label: 'Matches', contract: { contract_type: 'DIGITMATCH', barrier: 5, duration: 1 }, fair: 0.1, group: 'Matches / Differs', types: ['DIGITMATCH'] },
};

function growthInputs() {
  const n = (id, fb) => { const v = Number($(id).value); return Number.isFinite(v) && v > 0 ? v : fb; };
  const start = n('gr-start', currentBalance() || 10);
  return {
    key: $('gr-contract').value,
    start,
    goal: n('gr-goal', start * 2),
    pct: n('gr-pct', 5),
    tp: n('gr-tp', 10),
    sl: n('gr-sl', 20),
    trades: Math.round(n('gr-trades', 20)),
    days: Math.round(n('gr-days', 30)),
  };
}

// The win rate the bot has actually achieved on this contract (all accounts), once there's enough data.
function measuredWinRate(c) {
  const list = state.history.filter((h) => c.types.includes(h.type) && (!c.prefix || h.contract.startsWith(c.prefix)));
  return list.length >= 30 ? { p: list.filter((h) => h.won).length / list.length, n: list.length } : { p: null, n: list.length };
}

let growthTimer = null;
const scheduleGrowth = () => { clearTimeout(growthTimer); growthTimer = setTimeout(renderGrowth, 200); };

async function renderGrowth() {
  const g = growthInputs();
  const c = GROWTH_CONTRACTS[g.key];
  let payout = null;
  try {
    payout = await payoutPerUnit(client, '1HZ100V', { ...c.contract, duration_unit: 't' });
  } catch { /* offline: no quote */ }
  const measured = measuredWinRate(c);
  const p = measured.p ?? c.fair;
  const cur = state.account?.currency ?? 'USD';
  if (!payout) {
    $('gr-odds').innerHTML = '<span class="muted">Waiting for a live payout quote from Deriv…</span>';
    return;
  }
  const evFair = expectedValue(c.fair, payout);
  const ev = expectedValue(p, payout);
  $('gr-odds').innerHTML = `
    <div>${esc(c.label)} pays <b>${payout.toFixed(2)}</b> per 1.00 — win <b>+${(payout - 1).toFixed(2)}</b>, lose <b>−1.00</b>. Break-even win rate <b>${pct(1 / payout, 1)}</b>.</div>
    <div>At fair odds (${pct(c.fair, 0)} wins) the house keeps <b class="neg">${pct(-evFair, 1)}</b> of every stake.</div>
    <div>${measured.p !== null
      ? `Your bot's measured win rate on ${esc(c.label)}: <b class="${ev > 0 ? 'pos' : 'neg'}">${pct(measured.p, 1)}</b> over ${measured.n} trades → <b class="${ev > 0 ? 'pos' : 'neg'}">${ev > 0 ? '+' : ''}${(ev * 100).toFixed(1)}%</b> per stake.`
      : `Not enough trades yet (${measured.n}/30) to measure your bot's win rate on ${esc(c.label)} — simulating at fair odds.`}</div>`;

  const sim = simulateGrowth({ start: g.start, target: g.goal, pct: g.pct, p, payout, days: g.days, tradesPerDay: g.trades, dailyTargetPct: g.tp, dailyStopPct: g.sl, maxLossStreak: riskSettings().maxStreak, runs: 2000, seed: 7 });
  $('gr-result').innerHTML = `
    <div class="stat"><span>Chance to reach ${num(g.goal)}</span><b class="${sim.pTarget >= 0.5 ? 'up' : ''}">${pct(sim.pTarget, 0)}</b></div>
    <div class="stat"><span>Chance to empty the account</span><b class="${sim.pRuin > 0.05 ? 'down' : ''}">${pct(sim.pRuin, 0)}</b></div>
    <div class="stat"><span>Typical balance after ${g.days} days</span><b class="${sim.median >= g.start ? 'up' : 'down'}">${num(sim.median)} ${esc(cur)}</b></div>
    <div class="stat"><span>Bad / good luck range</span><b>${num(sim.p10)} – ${num(sim.p90)}</b></div>
    <div class="stat"><span>Typical days to goal</span><b>${sim.medianDaysToTarget ?? '–'}</b></div>
    <div class="stat"><span>First stake</span><b>${num(compoundStake(g.start, g.pct))}</b></div>`;
  const v = $('gr-verdict');
  if (ev > 0 && measured.p !== null) {
    v.className = 'gr-verdict good';
    v.textContent = `Your bot has a measured edge on ${c.label}. Keep stakes at ${g.pct}% and let the daily target and stop do their job — and keep checking the edge holds as trades pile up.`;
  } else if (sim.median >= g.start) {
    v.className = 'gr-verdict';
    v.textContent = 'This plan holds the balance in a typical run, but growth depends on luck until a strategy proves a real edge.';
  } else {
    v.className = 'gr-verdict bad';
    v.textContent = `Without a proven edge, ${c.label} shrinks the account on average (Deriv's margin). The daily stop and small stakes keep losses slow — use paper mode until the Earnings panel shows a strategy beating its break-even rate.`;
  }
  $('gr-ladder').innerHTML = `<thead><tr><th>Balance</th><th>Stake</th></tr></thead><tbody>${stakeLadder(g.start, g.goal, g.pct)
    .slice(0, 12).map((r) => `<tr><td class="num">${num(r.balance)}</td><td class="num">${num(r.stake)}</td></tr>`).join('')}</tbody>`;
  $('gr-balance').textContent = state.account
    ? `Live ${state.account.account_type} balance: ${num(state.balance)} ${cur}.`
    : `Paper balance: ${num(paperBalance())} USD (started at ${num(paperStart())}).`;
}

// Turn the plan into the bot's settings: compounding stake, daily target/stop, 2-loss lock, one contract type.
function applyGrowthPlan() {
  const g = growthInputs();
  const c = GROWTH_CONTRACTS[g.key];
  const set = (id, value) => { $(id).value = String(value); $(id).dispatchEvent(new Event('change')); };
  set('risk-sizing', 'compound');
  set('risk-stakepct', g.pct);
  // The % cap must allow Deriv's minimum stake on this balance.
  set('risk-pct', Math.max(g.pct, Math.ceil(((MIN_STAKE / g.start) * 100) * 10) / 10));
  set('risk-sl', Math.round(g.start * g.sl) / 100);
  set('risk-tp', Math.round(g.start * g.tp) / 100);
  set('risk-trades', g.trades);
  set('risk-recovery', 'off');
  set('risk-max', 2);
  for (const box of document.querySelectorAll('#ap-groups input')) {
    box.checked = box.value === c.group;
    store.set(`ap.${box.value}`, box.checked ? '1' : '0');
  }
  if (!state.account) {
    store.set('paper.start', String(g.start));
    state.paperSession = newSession();
    saveJson('paperSession', state.paperSession);
  } else {
    state.session = newSession();
    saveJson('session', state.session);
  }
  addThoughts([`Growth plan applied: ${g.pct}% stakes on ${c.label}, +${g.tp}% / −${g.sl}% per day, max ${g.trades} trades`]);
  renderRisk();
  renderCards();
  renderAutopilot();
  renderGrowth();
  alert(`Plan applied to the bot:\n\n• Stake: ${g.pct}% of balance (first stake ${num(compoundStake(g.start, g.pct))})\n• Only ${c.label}\n• Stop for the day at +${num(Math.round(g.start * g.tp) / 100)} or −${num(Math.round(g.start * g.sl) / 100)}\n• Max ${g.trades} trades, lock after 2 losses in a row\n\nEngage the Autopilot to run it${state.account ? '' : ' in paper mode'}.`);
}

function initGrowth() {
  $('gr-start').value = store.get('gr.start', String(currentBalance() || 10));
  $('gr-goal').value = store.get('gr.goal', String(Number($('gr-start').value) * 2));
  $('gr-contract').value = store.get('gr.contract', 'EO');
  for (const id of ['gr-start', 'gr-goal', 'gr-contract', 'gr-pct', 'gr-tp', 'gr-sl', 'gr-trades', 'gr-days']) {
    if (id !== 'gr-start' && id !== 'gr-goal' && id !== 'gr-contract') $(id).value = store.get(`gr.${id.slice(3)}`, $(id).value);
    $(id).addEventListener('change', () => { store.set(`gr.${id.slice(3)}`, $(id).value); scheduleGrowth(); });
  }
  $('gr-apply').onclick = applyGrowthPlan;
  $('gr-paper').onclick = () => {
    if (!confirm(`Reset the paper account to ${num(growthInputs().start)} and clear paper results?`)) return;
    store.set('paper.start', String(growthInputs().start));
    state.history = state.history.filter((h) => h.acct !== 'paper');
    state.paperSession = newSession();
    state.paperRisk = { lossStreak: 0, lockedUntil: 0, cold: {} };
    saveJson('history', state.history);
    saveJson('paperSession', state.paperSession);
    saveJson('paperRisk', state.paperRisk);
    renderEarnings();
    renderRisk();
    renderGrowth();
  };
}

// ---------- quick trade ticket: set every detail yourself ----------

const TICKET_TYPES = {
  RISE: { type: 'CALL', label: 'Rise' }, FALL: { type: 'PUT', label: 'Fall' },
  EVEN: { type: 'DIGITEVEN', label: 'Even' }, ODD: { type: 'DIGITODD', label: 'Odd' },
  OVER: { type: 'DIGITOVER', label: 'Over', digits: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
  UNDER: { type: 'DIGITUNDER', label: 'Under', digits: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  MATCHES: { type: 'DIGITMATCH', label: 'Matches', digits: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
  DIFFERS: { type: 'DIGITDIFF', label: 'Differs', digits: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
};

function renderTicket() {
  if (!$('tk-market')) return;
  const tradeable = SYMBOLS.filter((s) => s.kind !== 'none' && s.open);
  const keep = $('tk-market').value;
  $('tk-market').innerHTML = tradeable.map((s) => `<option value="${esc(s.symbol)}">${esc(s.family)} · ${esc(s.name)}</option>`).join('');
  $('tk-market').value = tradeable.some((s) => s.symbol === keep) ? keep : (tradeable.some((s) => s.symbol === state.symbol) ? state.symbol : tradeable[0]?.symbol ?? '');
  renderTicketOptions();
}

function renderTicketOptions() {
  const entry = entryOf($('tk-market').value);
  const kind = entry?.kind ?? 'digits';
  const types = kind === 'digits' ? Object.keys(TICKET_TYPES) : ['RISE', 'FALL'];
  const keepType = $('tk-type').value;
  $('tk-type').innerHTML = types.map((t) => `<option value="${t}">${TICKET_TYPES[t].label}</option>`).join('');
  if (types.includes(keepType)) $('tk-type').value = keepType;
  const t = TICKET_TYPES[$('tk-type').value];
  $('tk-digit-wrap').hidden = !t.digits;
  if (t.digits) {
    const keepDigit = $('tk-digit').value;
    $('tk-digit').innerHTML = t.digits.map((d) => `<option>${d}</option>`).join('');
    $('tk-digit').value = t.digits.includes(Number(keepDigit)) ? keepDigit : String(t.digits[Math.floor(t.digits.length / 2)]);
  }
  const minutes = kind === 'minutes';
  $('tk-unit').textContent = minutes ? 'minutes' : 'ticks';
  $('tk-duration').min = minutes ? entry.minMinutes : 1;
  $('tk-duration').max = minutes ? 1440 : 10;
  if (minutes && Number($('tk-duration').value) < entry.minMinutes) $('tk-duration').value = entry.minMinutes;
  if (!minutes && Number($('tk-duration').value) > 10) $('tk-duration').value = 5;
  renderTicketButton();
}

// Live parts only (never rebuilds the dropdowns, so it's safe to call often).
function renderTicketButton() {
  if (!$('tk-buy') || !$('tk-market').value) return;
  const entry = entryOf($('tk-market').value);
  const kind = entry?.kind ?? 'digits';
  const minutes = kind === 'minutes';
  $('tk-stake').placeholder = `risk stake ${num(stakeNow())}`;
  const blockers = state.account ? ticketBlockers() : [];
  $('tk-buy').disabled = !state.account || blockers.length > 0;
  $('tk-buy').textContent = state.account ? `Buy · ${num(ticketStake())} ${state.account.currency}` : 'Link account to trade';
  $('tk-note').textContent = !state.account
    ? 'Link your Deriv account to place manual trades.'
    : blockers.length ? `Blocked: ${blockers.join(' · ')}`
    : `${entry?.name}: ${minutes ? `Rise/Fall only, at least ${entry.minMinutes} minutes.` : kind === 'ticks' ? 'Rise/Fall on ticks.' : 'all tick contracts.'} Your risk limits (stop-loss, 2-loss lock, stake cap) still apply.`;
}

const ticketStake = () => { const v = Number($('tk-stake').value); return v > 0 ? v : stakeNow(); };

function ticketContract() {
  const entry = entryOf($('tk-market').value);
  const t = TICKET_TYPES[$('tk-type').value];
  const minutes = entry?.kind === 'minutes';
  const duration = Math.max(Number($('tk-duration').min), Math.round(Number($('tk-duration').value) || 1));
  const barrier = t.digits ? Number($('tk-digit').value) : undefined;
  return {
    contract_type: t.type, barrier, duration, duration_unit: minutes ? 'm' : 't',
    label: `${t.label}${barrier !== undefined ? ` ${barrier}` : ''} · ${duration} ${minutes ? 'min' : duration === 1 ? 'tick' : 'ticks'}`,
  };
}

// Manual trades skip the strategy-quality rules (they're your call) but keep every money limit.
function ticketBlockers() {
  return preTradeCheck({
    stake: ticketStake(), base: baseStake(), settings: { ...riskSettings(), strict: false },
    session: state.session, balance: state.balance, verdict: 'manual', locked: riskLocked(),
  });
}

async function buyTicket() {
  if (!state.account || !state.trader) return;
  const blockers = ticketBlockers();
  if (blockers.length) return alert(`Trade blocked by your risk limits:\n\n• ${blockers.join('\n• ')}`);
  const symbol = $('tk-market').value;
  const contract = ticketContract();
  const stake = ticketStake();
  const acct = state.account;
  if (acct.account_type !== 'demo' && !confirm(`REAL MONEY on ${acct.account_id}: buy ${contract.label} on ${entryOf(symbol)?.name ?? symbol} for ${stake} ${acct.currency}?`)) return;
  $('tk-buy').disabled = true;
  try {
    await executeTrade({ symbol, contract, stake, meta: { strategyId: null, strategyName: 'Manual ticket', group: groupOfType(contract.contract_type) } });
  } catch { /* shown in the trade log */ }
  renderTicketOptions();
}

function initTicket() {
  $('tk-market').onchange = renderTicketOptions;
  $('tk-type').onchange = renderTicketOptions;
  for (const id of ['tk-digit', 'tk-duration', 'tk-stake']) $(id).addEventListener('change', renderTicketOptions);
  $('tk-buy').onclick = buyTicket;
  renderTicket();
}

// ---------- robot voice ----------

function speak(text) {
  if (!$('voice').checked || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.pitch = 0.4;
    u.rate = 1.05;
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find((v) => /en[-_]/i.test(v.lang) && /male|david|daniel|google uk/i.test(v.name)) ?? voices.find((v) => /^en/i.test(v.lang)) ?? null;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* speech unavailable */ }
}

// ---------- boot ----------

function bootSequence() {
  const lines = [
    'STINCHEZ NEURAL CORE v2.0',
    'Linking to Deriv market grid…',
    'Loading 12 guide strategies…',
    'Calibrating 20 indicators…',
    'Arming self-scan across 10 volatility indices…',
  ];
  const log = $('boot-log');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  lines.forEach((l, k) => setTimeout(() => {
    const li = document.createElement('li');
    li.textContent = l;
    log.append(li);
    $('boot-bar').style.width = `${((k + 1) / (lines.length + 1)) * 100}%`;
  }, reduced ? 0 : k * 260));
  const globe = new Globe($('boot-globe'));
  globe.start();
  const shownAt = Date.now();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    $('boot-bar').style.width = '100%';
    setTimeout(() => $('boot').classList.add('gone'), reduced ? 0 : 350);
    setTimeout(() => globe.stop(), 1200); // stop drawing once the fade is over
  };
  $('boot').onclick = finish;
  // Data ready: leave the globe up for at least ~3.5s so it can be seen.
  return () => setTimeout(finish, reduced ? 0 : Math.max(0, 3500 - (Date.now() - shownAt)));
}

initControls();
buildCards();
initLearning();
initAutopilot();
initEarnings();
initTicket();
initGrowth();
resumeOAuth();
new Tunnel($('chart-tunnel')).start();
const bootDone = bootSequence();
setInterval(tickClock, 250);
client.connect()
  .then(async () => {
    // Every market Deriv offers right now; the built-in Volatility list stays if this fails.
    try {
      setSymbols(await loadCatalog(client));
      renderSymbolSelect();
      renderTicket();
      renderGrowth();
    } catch (err) {
      console.warn('market list unavailable, using Volatility indices only:', err.message);
    }
    await loadMarket();
    setTimeout(bootDone, 600);
    if (store.get('autoscan', '1') === '1') startScanner();
  })
  .catch((err) => {
    $('sym-name').textContent = `Cannot reach Deriv: ${err.message}`;
    bootDone();
  });
