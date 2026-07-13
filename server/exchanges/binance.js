import WebSocket from "ws";

const REST = "https://fapi.binance.com";
export const name = "binance";

/** Live 24h tickers for every USDT-M perp via one WebSocket stream. */
export function startTickers(onTicker, onStatus) {
  let delay = 1000;
  const connect = () => {
    const ws = new WebSocket("wss://fstream.binance.com/ws/!ticker@arr");
    ws.on("open", () => { delay = 1000; onStatus?.(name, "live"); });
    ws.on("message", buf => {
      let arr;
      try { arr = JSON.parse(buf); } catch { return; }
      if (!Array.isArray(arr)) return;
      for (const t of arr) {
        if (!t.s?.endsWith("USDT")) continue;
        onTicker(name, {
          base: t.s.slice(0, -4), sym: t.s,
          last: +t.c, chg: +t.P, vol: +t.q, trades: +t.n,
          hi24: +t.h, lo24: +t.l
        });
      }
    });
    ws.on("close", () => {
      onStatus?.(name, "down");
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15_000);
    });
    ws.on("error", () => { try { ws.close(); } catch {} });
  };
  connect();
}

/** Normalized klines: [{t,o,h,l,c}], oldest -> newest. */
export async function fetchKlines(sym, interval, limit) {
  const r = await fetch(`${REST}/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);
  if (!r.ok) throw new Error(`binance klines ${r.status}`);
  const j = await r.json();
  return j.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
}

/** Order book: { bids: [[price, qty]], asks: [[price, qty]] }, qty in base units. */
export async function fetchDepth(sym) {
  const r = await fetch(`${REST}/fapi/v1/depth?symbol=${sym}&limit=500`);
  if (!r.ok) throw new Error(`binance depth ${r.status}`);
  const j = await r.json();
  return {
    bids: j.bids.map(x => [+x[0], +x[1]]),
    asks: j.asks.map(x => [+x[0], +x[1]])
  };
}
