export function createCandleCache(ttlMs = 45_000) {
  const store = new Map(); // key -> { data, ts }
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (Date.now() - hit.ts > ttlMs) { store.delete(key); return null; }
      return hit.data;
    },
    set(key, data) {
      store.set(key, { data, ts: Date.now() });
    }
  };
}

export function createCandleHandler(market, connectors, cache) {
  return async function handleCandles(req, res) {
    const u = new URL(req.url, "http://x");
    const symbol = (u.searchParams.get("symbol") || "").toUpperCase();
    const interval = u.searchParams.get("interval") || "5m";
    const limit = Math.max(1, Math.min(Math.floor(+(u.searchParams.get("limit")) || 60), 500));

    const coin = market.coins.get(symbol);
    if (!coin) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unknown symbol" }));
      return;
    }

    const best = coin.best;
    const info = coin.sources[best];
    const conn = connectors[best];
    if (!conn?.fetchKlines || !info) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no source available" }));
      return;
    }

    const key = `${best}:${info.sym}:${interval}:${limit}`;
    let pending = cache.get(key);
    if (!pending) {
      // Cache the in-flight promise (not just the resolved value) so concurrent
      // requests for the same key await the same fetch instead of each starting
      // their own — the cache would otherwise only dedupe sequential requests.
      pending = conn.fetchKlines(info.sym, interval, limit).catch(err => {
        cache.set(key, null); // don't leave a rejected fetch cached; let the next request retry
        throw err;
      });
      cache.set(key, pending);
    }

    let candles;
    try {
      candles = await pending;
    } catch {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "fetch failed" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(candles));
  };
}
