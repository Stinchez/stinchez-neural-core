// Earnings from your settled real/demo trades: totals, breakdowns and an equity curve.

// history item: { t, symbol, stake, profit, won, auto, contract, type, strategyId, strategyName, group, acct, accountId, currency }

export function filterHistory(history, { acct = 'all', since = 0 } = {}) {
  return history.filter((h) => (acct === 'all' || h.acct === acct) && h.t >= since);
}

function bucket(list, keyOf, labelOf) {
  const map = new Map();
  for (const h of list) {
    const key = keyOf(h);
    const b = map.get(key) ?? { key, label: labelOf(h), trades: 0, wins: 0, pnl: 0, staked: 0 };
    b.trades++;
    if (h.won) b.wins++;
    b.pnl = round2(b.pnl + h.profit);
    b.staked = round2(b.staked + h.stake);
    map.set(key, b);
  }
  return [...map.values()]
    .map((b) => ({ ...b, winRate: b.wins / b.trades, roi: b.staked ? b.pnl / b.staked : 0 }))
    .sort((a, b) => b.pnl - a.pnl);
}

export function summarize(list) {
  const wins = list.filter((h) => h.won);
  const losses = list.filter((h) => !h.won);
  const net = round2(list.reduce((s, h) => s + h.profit, 0));
  const staked = round2(list.reduce((s, h) => s + h.stake, 0));
  // Cumulative P&L and the deepest fall from a previous high.
  let equity = 0, peak = 0, maxDrawdown = 0;
  const curve = list.slice().sort((a, b) => a.t - b.t).map((h) => {
    equity = round2(equity + h.profit);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, round2(peak - equity));
    return { t: h.t, equity };
  });
  return {
    trades: list.length,
    wins: wins.length,
    losses: losses.length,
    winRate: list.length ? wins.length / list.length : NaN,
    net,
    staked,
    roi: staked ? net / staked : NaN,
    avgWin: wins.length ? round2(wins.reduce((s, h) => s + h.profit, 0) / wins.length) : 0,
    avgLoss: losses.length ? round2(losses.reduce((s, h) => s + h.profit, 0) / losses.length) : 0,
    maxDrawdown,
    curve,
    byMarket: bucket(list, (h) => h.symbol, (h) => h.symbol),
    byStrategy: bucket(list, (h) => h.strategyId ?? 'manual', (h) => h.strategyName ?? 'Manual ticket'),
    byType: bucket(list, (h) => h.contract.replace(/\s*·.*$/, '').replace(/\s+\d+$/, ''), (h) => h.contract.replace(/\s*·.*$/, '').replace(/\s+\d+$/, '')),
    autoVsManual: bucket(list, (h) => (h.auto ? 'auto' : 'manual'), (h) => (h.auto ? 'Autopilot' : 'You (manual)')),
  };
}

export function toCsv(list) {
  const cols = ['time', 'account', 'account_type', 'market', 'contract', 'contract_type', 'strategy', 'by', 'stake', 'profit', 'result', 'currency'];
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = list.map((h) => [new Date(h.t).toISOString(), h.accountId, h.acct, h.symbol, h.contract, h.type, h.strategyName, h.auto ? 'autopilot' : 'manual', h.stake, h.profit, h.won ? 'won' : 'lost', h.currency]);
  return [cols, ...rows].map((r) => r.map(esc).join(',')).join('\n');
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
