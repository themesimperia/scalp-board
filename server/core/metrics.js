// Pure functions — no I/O. Candles are {h, l, c}, oldest -> newest.

/** NATR: average True Range over the series / last close * 100. Feed 15 5m candles for NATR(5m/14). */
export function natr(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  let sum = 0, n = 0;
  for (let i = 1; i < candles.length; i++) {
    const { h, l } = candles[i], pc = candles[i - 1].c;
    if (!(h > 0 && l > 0 && pc > 0)) continue;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    n++;
  }
  const last = candles[candles.length - 1].c;
  return n && last > 0 ? (sum / n) / last * 100 : null;
}

/** Average (high-low)/low % across candles. Feed 5 1m candles for Range(1m/5). */
export function avgRange(candles) {
  if (!Array.isArray(candles) || !candles.length) return null;
  let s = 0, n = 0;
  for (const k of candles) {
    if (k.l > 0 && k.h >= k.l) { s += (k.h - k.l) / k.l * 100; n++; }
  }
  return n ? s / n : null;
}

/**
 * Detect significant limit-order walls in an order book.
 * A wall = level within wallMaxDistPct of price, >= wallMinUsd notional,
 * and >= wallDominance x the median level size (so it stands out locally).
 */
export function detectWalls({ bids, asks, last, ex, sym }, cfg) {
  if (!(last > 0)) return [];
  const walls = [];
  const scan = (levels, side) => {
    if (!Array.isArray(levels) || !levels.length) return;
    const sizes = [];
    for (const [p, q] of levels) { const v = p * q; if (v > 0) sizes.push(v); }
    if (!sizes.length) return;
    sizes.sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    for (const [p, q] of levels) {
      const usd = p * q;
      if (usd < cfg.wallMinUsd) continue;
      const dist = Math.abs(p - last) / last * 100;
      if (dist > cfg.wallMaxDistPct) continue;
      if (median > 0 && usd < median * cfg.wallDominance) continue;
      walls.push({ ex, sym, side, price: p, usd: Math.round(usd), dist: +dist.toFixed(2) });
    }
  };
  scan(bids, "bid");
  scan(asks, "ask");
  return walls;
}
