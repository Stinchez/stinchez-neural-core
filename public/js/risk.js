// Risk control: session limits, the 2-step loss cap and the pre-trade check.
// Pure functions so the rules can be tested exactly; app.js owns the state.

import { MIN_STAKE } from './growth.js';

export const DEFAULT_RISK = {
  sizing: 'fixed',     // 'fixed' stake, or 'compound' = stakePct % of the current balance
  stakePct: 5,         // used when sizing is 'compound'
  maxStreak: 2,        // real losses in a row before the cooldown lock
  coolMin: 15,         // cooldown length
  stopLoss: null,      // session loss limit in account currency; null = one worst-case cycle
  takeProfit: null,    // stop for the session once up this much; null = off
  maxTrades: 10,       // trades per session
  maxStakePct: 2,      // largest stake allowed, as % of balance
  recovery: 'off',     // 'off' | 'martingale'
  multiplier: 1.5,     // the guide's compulsory martingale for Over 2/3/4
  maxSteps: 2,         // a recovery cycle may lose at most this many times
  strict: false,       // only strategies with a proven edge may trade
};

export function newSession(now = Date.now()) {
  return { start: now, pnl: 0, trades: 0, wins: 0, losses: 0, step: 0, ended: null };
}

// Stake for the next trade: the base stake, raised by the multiplier on each loss in the cycle.
export function nextStake(base, settings, session) {
  if (settings.recovery !== 'martingale') return round2(base);
  return round2(base * settings.multiplier ** Math.min(session.step, settings.maxSteps - 1));
}

// The most a full losing cycle can cost before the cap stops it.
export function worstCase(base, settings) {
  if (settings.recovery !== 'martingale') return round2(base * settings.maxStreak);
  let total = 0;
  for (let k = 0; k < settings.maxSteps; k++) total += base * settings.multiplier ** k;
  return round2(total);
}

export function stopLossAmount(base, settings) {
  return settings.stopLoss > 0 ? settings.stopLoss : worstCase(base, settings);
}

// Every reason the next trade must not be placed (empty array = allowed).
export function preTradeCheck({ stake, base, settings, session, balance, verdict, locked }) {
  const reasons = [];
  if (stake < MIN_STAKE - 1e-9) reasons.push(`Stake ${stake} is below Deriv's minimum of ${MIN_STAKE}`);
  if (balance > 0 && stake > balance + 1e-9) reasons.push(`Not enough balance (${balance}) for a ${stake} stake`);
  if (locked) reasons.push('Loss-streak cooldown is active');
  if (session.ended) reasons.push(`Session ended: ${session.ended}. Start a new session to trade again`);
  if (session.trades >= settings.maxTrades) reasons.push(`Max ${settings.maxTrades} trades this session reached`);
  const sl = stopLossAmount(base, settings);
  if (session.pnl - stake < -sl - 1e-9) reasons.push(`Losing this ${stake} stake would break your ${sl} stop-loss`);
  if (balance > 0 && stake > (balance * settings.maxStakePct) / 100 + 1e-9) {
    const cap = round2((balance * settings.maxStakePct) / 100);
    // On small accounts the % cap can fall below Deriv's minimum stake — say how to fix it.
    const hint = cap < MIN_STAKE ? ` — on a ${balance} balance raise "Max stake" to at least ${Math.ceil((MIN_STAKE / balance) * 1000) / 10}%` : '';
    reasons.push(`Stake is over ${settings.maxStakePct}% of your balance (max ${cap})${hint}`);
  }
  if (verdict === 'rejected') reasons.push('This strategy is proven worse than chance');
  if (settings.strict && verdict !== 'proven') reasons.push('Strict entries: strategy has no proven edge yet');
  return reasons;
}

// Fold a settled trade into the session. Returns what happened, for alerts.
export function applyOutcome(session, settings, base, { won, profit }) {
  const events = [];
  session.trades++;
  session.pnl = round2(session.pnl + profit);
  if (won) {
    session.wins++;
    session.step = 0;
  } else {
    session.losses++;
    session.step++;
    if (settings.recovery === 'martingale' && session.step >= settings.maxSteps) {
      session.step = 0;
      events.push('cycle-capped');
    }
  }
  const sl = stopLossAmount(base, settings);
  if (session.pnl <= -sl + 1e-9) { session.ended = `stop-loss hit (${session.pnl})`; events.push('stop-loss'); }
  else if (settings.takeProfit > 0 && session.pnl >= settings.takeProfit) { session.ended = `take-profit reached (+${session.pnl})`; events.push('take-profit'); }
  else if (session.trades >= settings.maxTrades) { session.ended = `${settings.maxTrades} trades done`; events.push('max-trades'); }
  return events;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
