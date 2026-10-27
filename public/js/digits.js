// Last-digit statistics and tick patterns for Deriv digit contracts.

export function lastDigit(quote, pip) {
  const s = Number(quote).toFixed(pip);
  return Number(s[s.length - 1]);
}

// The n-th digit after the decimal point (n = 2 is the guide's "second digit").
export function decimalDigit(value, n, pip) {
  const s = Number(value).toFixed(Math.max(pip, n));
  const frac = s.split('.')[1] ?? '';
  return Number(frac[n - 1] ?? 0);
}

export function distribution(digits) {
  const counts = new Array(10).fill(0);
  for (const d of digits) counts[d]++;
  const total = digits.length || 1;
  return counts.map((c) => c / total);
}

export function digitStats(digits, barrier = 5) {
  const n = digits.length || 1;
  let even = 0, over = 0, under = 0;
  for (const d of digits) {
    if (d % 2 === 0) even++;
    if (d > barrier) over++;
    if (d < barrier) under++;
  }
  const dist = distribution(digits);
  const ranked = dist.map((p, d) => ({ d, p })).sort((a, b) => b.p - a.p);
  return {
    count: digits.length,
    evenPct: even / n,
    oddPct: 1 - even / n,
    overPct: over / n,
    underPct: under / n,
    dist,
    hottest: ranked[0]?.d,
    coldest: ranked[ranked.length - 1]?.d,
  };
}

const parity = (d) => (d % 2 === 0 ? 'E' : 'O');

// Current run of identical parity at the end of the stream, e.g. "OOO".
export function parityStreak(digits) {
  if (!digits.length) return { kind: null, length: 0 };
  const kind = parity(digits[digits.length - 1]);
  let length = 0;
  for (let i = digits.length - 1; i >= 0 && parity(digits[i]) === kind; i--) length++;
  return { kind, length };
}

// Guide entry: two or more odd digits confirmed by one even [OOE]/[OOOE] => EVEN market,
// two or more even confirmed by one odd [EEO]/[EEEO] => ODD market.
export function parityEntry(digits, end = digits.length) {
  if (end < 3) return null;
  const last = parity(digits[end - 1]);
  let run = 0;
  for (let i = end - 2; i >= 0 && parity(digits[i]) !== last; i--) run++;
  if (run < 2) return null;
  return {
    market: last === 'E' ? 'EVEN' : 'ODD',
    pattern: (last === 'E' ? 'O' : 'E').repeat(Math.min(run, 4)) + last,
  };
}

// Guide entry for rise/fall: three consecutive falling ticks [FFF] before a RISE
// entry, three rising ticks [RRR] before a FALL entry.
export function tickRetest(quotes, end = quotes.length, count = 3) {
  if (end < count + 1) return null;
  let up = 0, down = 0;
  for (let i = end - count; i < end; i++) {
    if (quotes[i] > quotes[i - 1]) up++;
    else if (quotes[i] < quotes[i - 1]) down++;
  }
  if (down === count) return { market: 'RISE', pattern: 'F'.repeat(count) };
  if (up === count) return { market: 'FALL', pattern: 'R'.repeat(count) };
  return null;
}
