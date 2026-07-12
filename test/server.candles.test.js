import assert from "node:assert";
import http from "node:http";
import { Market } from "../server/core/market.js";
import { createCandleCache, createCandleHandler } from "../server/core/candleApi.js";
import * as mock from "../server/exchanges/mock.js";

// --- cache TTL behavior (no HTTP needed) ---
const cache = createCandleCache(50);
assert.strictEqual(cache.get("k"), null, "miss returns null");
cache.set("k", [1, 2, 3]);
assert.deepStrictEqual(cache.get("k"), [1, 2, 3], "hit returns stored value");
await new Promise(r => setTimeout(r, 80));
assert.strictEqual(cache.get("k"), null, "expired entry returns null");

// --- HTTP round-trip using the mock exchange (no real network) ---
const market = new Market();
market.upsert("mock", { base: "BTC", sym: "BTCUSDT", last: 68000, chg: 1, vol: 5e9 });

let fetchCount = 0;
const countingMock = { ...mock, fetchKlines: async (...args) => { fetchCount++; return mock.fetchKlines(...args); } };

const httpCache = createCandleCache(60_000);
const handleCandles = createCandleHandler(market, { mock: countingMock }, httpCache);

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/candles") { handleCandles(req, res); return; }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, resolve));
const { port } = server.address();

let r = await fetch(`http://localhost:${port}/api/candles?symbol=BTC&interval=5m&limit=10`);
assert.strictEqual(r.status, 200);
const candles = await r.json();
assert.strictEqual(candles.length, 10);
assert.ok(candles.every(k => k.h >= k.l), "every candle has h >= l");
assert.strictEqual(fetchCount, 1, "first request fetches once");

r = await fetch(`http://localhost:${port}/api/candles?symbol=BTC&interval=5m&limit=10`);
assert.strictEqual(r.status, 200);
assert.strictEqual(fetchCount, 1, "identical second request must be served from cache, not re-fetched");

r = await fetch(`http://localhost:${port}/api/candles?symbol=NOPE&interval=5m&limit=10`);
assert.strictEqual(r.status, 404, "unknown symbol returns 404");

server.close();
console.log("candle api tests passed ✔");
