export function createBarAggregator(intervalMs, maxBars = 200) {
  const state = new Map(); // symbol -> { bars: [...] }

  // A tick whose bucket is <= the current bar's t (browser clock trailing the
  // exchange server clock that seeded real history, or simple out-of-order
  // delivery) folds into the current bar rather than opening a new one —
  // bars must stay chronologically monotonic for canvas x-axis positioning
  // and the trend-line algorithm's index-based math to remain valid.
  function addTick(symbol, ts, price, vol = 0) {
    let s = state.get(symbol);
    if (!s) { s = { bars: [] }; state.set(symbol, s); }
    const bars = s.bars;
    const start = Math.floor(ts / intervalMs) * intervalMs;
    let cur = bars[bars.length - 1];
    if (!cur || start > cur.t) {
      const o = cur ? cur.c : price;
      cur = { t: start, o, h: price, l: price, c: price, v: 0 };
      bars.push(cur);
      if (bars.length > maxBars) bars.shift();
    }
    cur.h = Math.max(cur.h, price);
    cur.l = Math.min(cur.l, price);
    cur.c = price;
    cur.v += vol;
    return cur;
  }

  function getBars(symbol) {
    return state.get(symbol)?.bars || [];
  }

  function reset() {
    state.clear();
  }

  function seedBars(symbol, historicalBars) {
    const bars = historicalBars.slice(-maxBars).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 }));
    state.set(symbol, { bars });
  }

  return { addTick, getBars, reset, seedBars };
}

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

export function avgRange(candles) {
  if (!Array.isArray(candles) || !candles.length) return null;
  let s = 0, n = 0;
  for (const k of candles) {
    if (k.l > 0 && k.h >= k.l) { s += (k.h - k.l) / k.l * 100; n++; }
  }
  return n ? s / n : null;
}

export function selectCoins(coins, opts = {}) {
  const { minVol = 0, searchQ = "", tagFilter = "all", tags = new Map(), wlOnly = false, sortKey = "v", sortDir = -1 } = opts;
  let list = coins.filter(c => c.v >= minVol);
  if (tagFilter !== "all") list = list.filter(c => tags.get(c.s) === tagFilter);
  if (wlOnly) list = list.filter(c => tags.has(c.s)); // "favorites only": any tag color counts, matching the Screener's star/Watchlist toggle
  if (searchQ) list = list.filter(c => c.s.includes(searchQ));
  list = list.slice().sort((a, b) => {
    if (sortKey === "s") return sortDir * (a.s < b.s ? -1 : a.s > b.s ? 1 : 0);
    const va = a[sortKey], vb = b[sortKey];
    const am = va == null, bm = vb == null;
    if (am || bm) return am && bm ? 0 : am ? 1 : -1;
    return sortDir * (va - vb);
  });
  return list;
}

export function paginate(list, page, pageSize) {
  const start = page * pageSize;
  return list.slice(start, start + pageSize);
}

export function pageCount(listLength, pageSize) {
  return Math.max(1, Math.ceil(listLength / pageSize));
}

function findSwingPoints(bars, kind, window) {
  const field = kind === "high" ? "h" : "l";
  const points = [];
  for (let i = window; i < bars.length - window; i++) {
    const v = bars[i][field];
    let isSwing = true;
    for (let k = 1; k <= window; k++) {
      const left = bars[i - k][field], right = bars[i + k][field];
      const ok = kind === "high" ? (v > left && v > right) : (v < left && v < right);
      if (!ok) { isSwing = false; break; }
    }
    if (isSwing) points.push({ i, v });
  }
  return points;
}

function lineValueAt(p1, p2, i) {
  const slope = (p2.v - p1.v) / (p2.i - p1.i);
  return p1.v + slope * (i - p1.i);
}

function scoreCandidate(p1, p2, points, tolerancePct) {
  let touches = 0;
  for (const p of points) {
    if (p === p1 || p === p2) continue;
    const expected = lineValueAt(p1, p2, p.i);
    if (expected > 0 && Math.abs(p.v - expected) / expected <= tolerancePct) touches++;
  }
  return touches;
}

function isValidCandidate(p1, p2, bars, kind, tolerancePct) {
  const startI = Math.min(p1.i, p2.i);
  for (let i = startI; i < bars.length; i++) {
    const expected = lineValueAt(p1, p2, i);
    const close = bars[i].c;
    if (kind === "high") {
      if (close > expected * (1 + tolerancePct)) return false;
    } else {
      if (close < expected * (1 - tolerancePct)) return false;
    }
  }
  return true;
}

export function findTrendLine(bars, kind, { window = 2, tolerancePct = 0.0015 } = {}) {
  if (!Array.isArray(bars)) return null;
  const points = findSwingPoints(bars, kind, window);
  if (points.length < 2) return null;

  let best = null;
  for (let a = 0; a < points.length; a++) {
    for (let b = a + 1; b < points.length; b++) {
      const p1 = points[a], p2 = points[b];
      if (!isValidCandidate(p1, p2, bars, kind, tolerancePct)) continue;
      const score = scoreCandidate(p1, p2, points, tolerancePct);
      if (!best || score > best.score || (score === best.score && p2.i > best.p2.i)) {
        best = { p1, p2, score };
      }
    }
  }
  if (!best) return null;

  return {
    p1: best.p1,
    p2: best.p2,
    touches: best.score,
    valueAt: i => lineValueAt(best.p1, best.p2, i)
  };
}

export function findTrendLines(bars, opts) {
  return {
    resistance: findTrendLine(bars, "high", opts),
    support: findTrendLine(bars, "low", opts)
  };
}
