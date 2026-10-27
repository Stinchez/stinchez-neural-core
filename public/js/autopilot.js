// Autopilot decision: on every self-scan sweep, pick at most one trade to place.
// It only ever takes a READY signal from the robot brain, on any of the scanned
// markets, that passes the user's filters and the full risk pre-trade check.

export const AUTOPILOT_GROUPS = ['Rise / Fall', 'Even / Odd', 'Over / Under', 'Matches / Differs'];

export const DEFAULT_AUTOPILOT = {
  groups: [...AUTOPILOT_GROUPS],
  minStrength: 0.75, // robot signal strength (0-1); READY signals start at ~0.67
  gapSec: 10,        // minimum seconds between trades
};

/**
 * ranked: self-scan entries ({ symbol, name, smooth, brain }) best first.
 * blockersFor(strategyId, symbol) -> string[] from the risk pre-trade check.
 * Returns { trade } or { skip: reason }.
 */
export function pickAutoTrade(ranked, settings, { now, lastTradeAt = 0, busy = false }, blockersFor) {
  if (busy) return { skip: 'Waiting for the open trade to settle' };
  const wait = settings.gapSec * 1000 - (now - lastTradeAt);
  if (wait > 0) return { skip: `Spacing trades (${Math.ceil(wait / 1000)}s)` };
  let firstBlock = null;
  for (const r of ranked) {
    const a = r.brain?.action;
    if (!a) continue;
    if (!settings.groups.includes(a.group)) continue;
    if (r.brain.strength < settings.minStrength) continue;
    const blockers = blockersFor(a.id, r.symbol);
    if (blockers.length) { firstBlock ??= `${r.name}: ${blockers[0]}`; continue; }
    return {
      trade: {
        symbol: r.symbol, name: r.name, strategyId: a.id, strategyName: a.name,
        group: a.group, side: a.side, contract: a.contract, strength: r.brain.strength,
      },
    };
  }
  return { skip: firstBlock ?? 'Scanning — no READY signal passes the filters yet' };
}
