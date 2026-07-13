const REST = "https://api.bybit.com";
export const name = "bybit";

/** Bybit v5 has no all-tickers WS stream, so poll REST (one request covers every linear perp). */
export function startTickers(onTicker, onStatus, intervalMs = 3000) {
  let stopped = false;
  const poll = async () => {
    if (stopped) return;
    try {
      const r = await fetch(`${REST}/v5/market/tickers?category=linear`);
      const j = await r.json();
      for (const t of j.result?.list || []) {
        if (!t.symbol?.endsWith("USDT")) continue;
        onTicker(name, {
          base: t.symbol.slice(0, -4), sym: t.symbol,
          last: +t.lastPrice,
          chg: +t.price24hPcnt * 100,       // fraction -> percent
          vol: +t.turnover24h,              // quote (USDT) volume
          hi24: +t.highPrice24h, lo24: +t.lowPrice24h
        });
      }
      onStatus?.(name, "live");
    } catch { onStatus?.(name, "down"); }
    setTimeout(poll, intervalMs);
  };
  poll();
  return () => { stopped = true; };
}

/** interval "5m"/"1m" -> Bybit "5"/"1". List arrives newest-first; we reverse. */
export async function fetchKlines(sym, interval, limit) {
  const iv = interval.replace("m", "");
  const r = await fetch(`${REST}/v5/market/kline?category=linear&symbol=${sym}&interval=${iv}&limit=${limit}`);
  if (!r.ok) throw new Error(`bybit klines ${r.status}`);
  const j = await r.json();
  const list = (j.result?.list || []).slice().reverse();
  // [start, open, high, low, close, volume, turnover]
  return list.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
}

export async function fetchDepth(sym) {
  const r = await fetch(`${REST}/v5/market/orderbook?category=linear&symbol=${sym}&limit=200`);
  if (!r.ok) throw new Error(`bybit depth ${r.status}`);
  const j = await r.json();
  const res = j.result || {};
  return {
    bids: (res.b || []).map(x => [+x[0], +x[1]]),
    asks: (res.a || []).map(x => [+x[0], +x[1]])
  };
}
