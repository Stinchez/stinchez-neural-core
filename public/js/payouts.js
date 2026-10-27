// Real Deriv payout quotes (proposal), so paper trades can be valued in money.
// Deriv prices contracts on the public socket without a login.

const cache = new Map(); // key -> { payout per 1 stake, at }
const TTL = 60_000;

const keyOf = (symbol, c) => `${symbol}|${c.contract_type}|${c.barrier ?? ''}|${c.duration}${c.duration_unit ?? 't'}`;

// Payout for a 1.00 stake; scale by stake (payouts are proportional for fixed-odds contracts).
export async function payoutPerUnit(client, symbol, contract, currency = 'USD') {
  const key = keyOf(symbol, contract);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.payout;
  const req = {
    proposal: 1, amount: 1, basis: 'stake', currency,
    contract_type: contract.contract_type, duration: contract.duration, duration_unit: contract.duration_unit ?? 't',
    underlying_symbol: symbol,
  };
  if (contract.barrier !== undefined) req.barrier = String(contract.barrier);
  const { proposal } = await client.send(req);
  const payout = Number(proposal.payout) / Number(proposal.ask_price || 1);
  cache.set(key, { payout, at: Date.now() });
  return payout;
}

// Profit of a settled fixed-odds trade.
export const profitOf = (won, stake, payoutPerUnitValue) => Math.round((won ? stake * payoutPerUnitValue - stake : -stake) * 100) / 100;

// Win rate needed to break even at this payout.
export const breakEven = (payoutPerUnitValue) => (payoutPerUnitValue > 0 ? 1 / payoutPerUnitValue : NaN);
