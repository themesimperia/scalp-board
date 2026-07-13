const REST = "https://www.okx.com";
export const name = "okx";

// OKX order book sizes are in CONTRACTS, not coins. ctVal maps a contract to base units.
let ctVal = null;
async function loadContracts() {
  if (ctVal) return ctVal;
  const r = await fetch(`${REST}/api/v5/public/instruments?instType=SWAP`);
  const j = await r.json();
  ctVal = new Map();
  for (const i of j.data || []) ctVal.set(i.instId, +i.ctVal || 1);
  return ctVal;
}

/** Poll all USDT swap tickers in one request. */
export function startTickers(onTicker, onStatus, intervalMs = 3000) {
  let stopped = false;
  const poll = async () => {
    if (stopped) return;
    try {
      const r = await fetch(`${REST}/api/v5/market/tickers?instType=SWAP`);
      const j = await r.json();
      for (const t of j.data || []) {
        if (!t.instId?.endsWith("-USDT-SWAP")) continue;
        const base = t.instId.split("-")[0];
        const last = +t.last, open = +t.open24h;
        onTicker(name, {
          base, sym: t.instId, last,
          chg: open > 0 ? (last - open) / open * 100 : 0,
          vol: (+t.volCcy24h || 0) * last,    // base volume * price ≈ quote volume
          hi24: +t.high24h, lo24: +t.low24h
        });
      }
      onStatus?.(name, "live");
    } catch { onStatus?.(name, "down"); }
    setTimeout(poll, intervalMs);
  };
  poll();
  return () => { stopped = true; };
}

/** bar "5m"/"1m". Data arrives newest-first; we reverse. [ts,o,h,l,c,...] */
export async function fetchKlines(sym, interval, limit) {
  const r = await fetch(`${REST}/api/v5/market/candles?instId=${sym}&bar=${interval}&limit=${limit}`);
  if (!r.ok) throw new Error(`okx klines ${r.status}`);
  const j = await r.json();
  const list = (j.data || []).slice().reverse();
  return list.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
}

export async function fetchDepth(sym) {
  const [cv, r] = await Promise.all([
    loadContracts(),
    fetch(`${REST}/api/v5/market/books?instId=${sym}&sz=400`)
  ]);
  if (!r.ok) throw new Error(`okx depth ${r.status}`);
  const j = await r.json();
  const book = j.data?.[0] || {};
  const mult = cv.get(sym) || 1;
  const map = lvls => (lvls || []).map(x => [+x[0], +x[1] * mult]); // contracts -> base units
  return { bids: map(book.bids), asks: map(book.asks) };
}
