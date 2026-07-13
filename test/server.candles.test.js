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

// --- limit param sanitization: negative/fractional/invalid/zero/missing all clamp to sane positive ints ---
{
  let rr = await fetch(`http://localhost:${port}/api/candles?symbol=BTC&interval=5m&limit=-5`);
  assert.strictEqual(rr.status, 200);
  assert.strictEqual((await rr.json()).length, 1, "negative limit clamps to 1");

  rr = await fetch(`http://localhost:${port}/api/candles?symbol=BTC&interval=5m&limit=10.5`);
  assert.strictEqual(rr.status, 200);
  assert.strictEqual((await rr.json()).length, 10, "fractional limit floors down");

  rr = await fetch(`http://localhost:${port}/api/candles?symbol=BTC&interval=5m&limit=abc`);
  assert.strictEqual(rr.status, 200);
  assert.strictEqual((await rr.json()).length, 60, "non-numeric limit falls back to default 60");

  rr = await fetch(`http://localhost:${port}/api/candles?symbol=BTC&interval=5m&limit=0`);
  assert.strictEqual(rr.status, 200);
  assert.strictEqual((await rr.json()).length, 60, "zero limit falls back to default 60");

  rr = await fetch(`http://localhost:${port}/api/candles?symbol=BTC&interval=5m`);
  assert.strictEqual(rr.status, 200);
  assert.strictEqual((await rr.json()).length, 60, "missing limit param defaults to 60");

  rr = await fetch(`http://localhost:${port}/api/candles?symbol=BTC&interval=5m&limit=9999`);
  assert.strictEqual(rr.status, 200);
  assert.strictEqual((await rr.json()).length, 500, "oversized limit caps at 500");
}

// --- 502 path coverage: connector missing entirely, and connector whose fetchKlines rejects ---
{
  const m502 = new Market();
  m502.upsert("ghost", { base: "GHOST", sym: "GHOSTUSDT", last: 1, chg: 0, vol: 1e6 }); // no "ghost" connector registered below
  m502.upsert("boom", { base: "BOOM", sym: "BOOMUSDT", last: 1, chg: 0, vol: 1e6 });
  const boomConn = { fetchKlines: async () => { throw new Error("boom"); } };
  const cache502 = createCandleCache(60_000);
  const handle502 = createCandleHandler(m502, { boom: boomConn }, cache502);

  const server502 = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/candles") { handle502(req, res); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server502.listen(0, resolve));
  const port502 = server502.address().port;

  let rr = await fetch(`http://localhost:${port502}/api/candles?symbol=GHOST&interval=5m&limit=10`);
  assert.strictEqual(rr.status, 502, "connector missing from connectors map -> 502");

  rr = await fetch(`http://localhost:${port502}/api/candles?symbol=BOOM&interval=5m&limit=10`);
  assert.strictEqual(rr.status, 502, "connector fetchKlines rejects -> 502");

  server502.close();
}

// --- cache-stampede fix: two concurrent requests for the same never-before-requested key
//     must dedupe to a single upstream fetchKlines call, not one per request ---
{
  let raceCount = 0;
  const raceMock = {
    ...mock,
    fetchKlines: async (...args) => {
      raceCount++;
      await new Promise(r => setTimeout(r, 20)); // widen the race window past both requests starting
      return mock.fetchKlines(...args);
    }
  };
  const raceMarket = new Market();
  raceMarket.upsert("mock", { base: "SOL", sym: "SOLUSDT", last: 190, chg: 1, vol: 3e9 });
  const raceCache = createCandleCache(60_000);
  const handleRace = createCandleHandler(raceMarket, { mock: raceMock }, raceCache);

  const raceServer = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/candles") { handleRace(req, res); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => raceServer.listen(0, resolve));
  const racePort = raceServer.address().port;

  const [ra, rb] = await Promise.all([
    fetch(`http://localhost:${racePort}/api/candles?symbol=SOL&interval=5m&limit=10`),
    fetch(`http://localhost:${racePort}/api/candles?symbol=SOL&interval=5m&limit=10`)
  ]);
  assert.strictEqual(ra.status, 200);
  assert.strictEqual(rb.status, 200);
  const [ja, jb] = await Promise.all([ra.json(), rb.json()]);
  assert.strictEqual(ja.length, 10);
  assert.deepStrictEqual(ja, jb, "both concurrent requests receive the same candle data");
  assert.strictEqual(raceCount, 1, "two concurrent requests for the same key trigger only one upstream fetch");

  raceServer.close();
}

server.close();

// --- fetchKlines includes t (open time) and o (open price), aligned to interval boundaries ---
{
  const candles = await mock.fetchKlines("BTCUSDT", "5m", 5);
  assert.strictEqual(candles.length, 5);
  for (const k of candles) {
    assert.ok(typeof k.t === "number" && k.t > 0, "candle has numeric t");
    assert.ok(typeof k.o === "number" && k.o > 0, "candle has numeric o");
    assert.strictEqual(k.t % 300_000, 0, "t aligns to the 5m interval boundary");
  }
  for (let i = 1; i < candles.length; i++) {
    assert.strictEqual(candles[i].t - candles[i - 1].t, 300_000, "consecutive candles are exactly one interval apart");
  }
}

console.log("candle api tests passed ✔");
