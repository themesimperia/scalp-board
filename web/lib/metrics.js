export function createBarAggregator(intervalMs, maxBars = 200) {
  const state = new Map(); // symbol -> { bars: [...] }

  function addTick(symbol, ts, price, vol = 0) {
    let s = state.get(symbol);
    if (!s) { s = { bars: [] }; state.set(symbol, s); }
    const bars = s.bars;
    const start = Math.floor(ts / intervalMs) * intervalMs;
    let cur = bars[bars.length - 1];
    if (!cur || cur.t !== start) {
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

  return { addTick, getBars, reset };
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
  const { minVol = 0, searchQ = "", tagFilter = "all", tags = new Map(), sortKey = "v", sortDir = -1 } = opts;
  let list = coins.filter(c => c.v >= minVol);
  if (tagFilter !== "all") list = list.filter(c => tags.get(c.s) === tagFilter);
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
