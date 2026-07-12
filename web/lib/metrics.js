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
