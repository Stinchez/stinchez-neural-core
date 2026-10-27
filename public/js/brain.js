// The "robot mind": weighs every strategy, the deep analysis and each
// strategy's proven track record into one bias per market type, then picks
// the single best action (or tells you to stand aside).

import { STRATEGIES } from './strategies.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// Looked up live: learned strategies are added to STRATEGIES at runtime.
const byIdOf = () => Object.fromEntries(STRATEGIES.map((s) => [s.id, s]));

// How much to trust a strategy given its replayed record.
export function edgeFactor(rec) {
  if (!rec || rec.trades < 20) return 0.8; // unproven
  if (rec.ci[1] < rec.baseline) return 0.3; // proven worse than chance
  return clamp(1 + (rec.winRate - rec.baseline) * 5, 0.5, 1.5);
}

function vote(items) {
  let net = 0, total = 0;
  for (const { dir, weight } of items) {
    if (!Number.isFinite(dir) || !weight) continue;
    net += dir * weight;
    total += weight;
  }
  return total ? net / total : 0;
}

export function think(deep, results, records) {
  const thoughts = [];
  const byId = byIdOf();
  const res = (id) => results[id];
  const sideDir = { RISE: 1, FALL: -1, EVEN: 1, ODD: -1, UNDER: 1, OVER: -1, MATCHES: 1, DIFFERS: -1 };
  const idsIn = (group) => STRATEGIES.filter((s) => s.group === group).map((s) => s.id).filter(res);

  // Rise / Fall: trend structure + guide strategies.
  const [tf1, tf5, tf15] = deep.mtf;
  const trending = deep.adx > 25;
  const rfItems = [
    { dir: tf1.dir, weight: 1 },
    { dir: tf5.dir, weight: 1.5 },
    { dir: tf15.dir, weight: 2 },
    { dir: deep.supertrend.dir, weight: 1.5 },
    { dir: trending ? Math.sign(deep.plusDI - deep.minusDI) : 0, weight: trending ? 1.5 : 0 },
    ...idsIn('Rise / Fall').map((id) => ({ dir: sideDir[res(id).side] * res(id).score, weight: 2 * edgeFactor(records[id]) })),
  ];
  let rf = vote(rfItems);
  if (deep.adx < 20) rf *= 0.7;
  thoughts.push(`Trend map: ${deep.mtf.map((t) => `${t.tf} ${t.dir > 0 ? '▲' : t.dir < 0 ? '▼' : '▬'}`).join(' · ')}`);
  thoughts.push(`ADX ${deep.adx.toFixed(0)} → ${trending ? 'trending market' : deep.adx < 20 ? 'ranging, trend signals weak' : 'building trend'}`);
  thoughts.push(`Supertrend ${deep.supertrend.dir > 0 ? 'bullish' : 'bearish'} · volatility ${deep.atrPct > 0.8 ? 'wild' : deep.atrPct < 0.2 ? 'calm' : 'normal'}`);

  // Even / Odd: guide strategies + recent parity skew.
  const looksRandom = deep.chi.pValue > 0.05;
  const eoItems = [
    ...idsIn('Even / Odd').map((id) => ({ dir: sideDir[res(id).side] * res(id).score, weight: 2 * edgeFactor(records[id]) })),
    { dir: clamp(deep.parityZ / 3, -1, 1), weight: 0.5 },
  ];
  let eo = vote(eoItems);
  if (looksRandom) eo = clamp(eo, -0.6, 0.6);
  thoughts.push(`Digits ${looksRandom ? 'look random' : 'show a real skew'} (χ² p=${deep.chi.pValue.toFixed(2)}, entropy ${(deep.entropy * 100).toFixed(1)}%)`);
  thoughts.push(`Parity runs z=${deep.runs.z.toFixed(2)} → ${deep.runs.z < -2 ? 'streaky' : deep.runs.z > 2 ? 'alternating' : 'normal mixing'}`);

  // Over / Under.
  let ou = vote(idsIn('Over / Under').map((id) => ({ dir: sideDir[res(id).side] * res(id).score, weight: edgeFactor(records[id]) })));
  if (looksRandom) ou = clamp(ou, -0.6, 0.6);

  // Matches / Differs: digit-only strategies, so randomness caps confidence the same way.
  let md = vote(idsIn('Matches / Differs').map((id) => ({ dir: sideDir[res(id).side] * res(id).score, weight: edgeFactor(records[id]) })));
  if (looksRandom) md = clamp(md, -0.6, 0.6);

  const verdicts = {
    'Rise / Fall': { bias: rf >= 0 ? 'RISE' : 'FALL', confidence: Math.abs(rf) },
    'Even / Odd': { bias: eo >= 0 ? 'EVEN' : 'ODD', confidence: Math.abs(eo) },
    'Over / Under': { bias: ou >= 0 ? 'UNDER' : 'OVER', confidence: Math.abs(ou) },
    'Matches / Differs': { bias: md >= 0 ? 'MATCHES' : 'DIFFERS', confidence: Math.abs(md) },
  };

  // Score every strategy by rule confluence, agreement with its group bias and proven edge
  // (max 2 x 1.5 x 1 = 3). The best READY one is the action; the best overall is the plan.
  let action = null, best = null;
  for (const [id, r] of Object.entries(results)) {
    if (!r) continue;
    const s = byId[id];
    const v = verdicts[s.group];
    const agree = v.bias === r.side ? 1 + v.confidence : 1 - v.confidence;
    const score = agree * edgeFactor(records[id]) * r.score;
    const cand = { id, name: s.name, group: s.group, side: r.side, contract: r.contract, score, ready: r.ready, setupOk: r.setupOk, entry: r.entry, record: records[id] };
    const tier = (c) => (c.ready ? 2 : c.setupOk ? 1 : 0) + c.score / 3;
    if (r.ready && (!action || score > action.score)) action = cand;
    if (!best || tier(cand) > tier(best)) best = cand;
  }
  if (action) {
    const rec = records[action.id];
    thoughts.push(`READY: ${action.group} → ${action.side} (${action.contract.label})${rec?.trades ? `, replay win ${(rec.winRate * 100).toFixed(1)}% vs chance ${(rec.baseline * 100).toFixed(0)}%` : ''}`);
  } else {
    const waiting = Object.entries(results).filter(([, r]) => r?.setupOk).map(([id]) => byId[id]);
    thoughts.push(waiting.length ? `Setup complete on ${waiting.map((s) => s.group.split(' ')[0] + ' ' + s.name.split(' · ')[0]).join(', ')}; waiting for entry` : 'No full setup — standing aside');
  }

  // Market score 0..3: 2+ READY, 1+ setup complete, below 1 partial confluence.
  const marketScore = best ? (best.ready ? 2 : best.setupOk ? 1 : 0) + best.score / 3 : 0;

  // Short, human reasons for the "best volatility" card.
  const reasons = [];
  if (best) reasons.push(`${best.ready ? 'READY' : best.setupOk ? 'Setup complete' : 'Partial setup'}: ${best.group} → ${best.side}`);
  const aligned = deep.mtf.filter((t) => t.dir !== 0 && t.dir === deep.mtf[0].dir).length;
  if (aligned >= 2) reasons.push(`Trend aligned on ${aligned}/3 timeframes (${deep.mtf[0].dir > 0 ? 'up' : 'down'})`);
  if (deep.adx > 25) reasons.push(`Strong trend · ADX ${deep.adx.toFixed(0)}`);
  else if (deep.adx < 20) reasons.push(`Ranging market · ADX ${deep.adx.toFixed(0)}`);
  if (!looksRandom) reasons.push(`Digit skew detected (χ² p=${deep.chi.pValue.toFixed(3)})`);
  if (best?.record?.trades >= 20) {
    const r = best.record;
    reasons.push(`Replay: ${(r.winRate * 100).toFixed(1)}% win vs ${(r.baseline * 100).toFixed(0)}% chance over ${r.trades} trades`);
  }

  return {
    verdicts,
    action,
    best,
    reasons,
    thoughts,
    marketScore,
    strength: marketScore / 3,
    mood: action ? 'go' : best?.setupOk ? 'wait' : 'idle',
  };
}
