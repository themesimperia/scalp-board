import assert from "node:assert";
import { natr, avgRange, detectWalls } from "../server/core/metrics.js";
import { Market } from "../server/core/market.js";

// --- natr ---
const flat = Array.from({ length: 15 }, () => ({ h: 100, l: 100, c: 100 }));
assert.strictEqual(natr(flat), 0, "flat candles -> NATR 0");

const oneRange = [{ h: 100, l: 100, c: 100 }, { h: 101, l: 99, c: 100 }];
assert.ok(Math.abs(natr(oneRange) - 2) < 1e-9, "single 2-wide candle on 100 -> 2%");
assert.strictEqual(natr([]), null);
assert.strictEqual(natr(null), null);

// --- avgRange ---
assert.ok(Math.abs(avgRange([{ h: 101, l: 100, c: 100.5 }]) - 1) < 1e-9, "1% range");
assert.strictEqual(avgRange([]), null);

// --- detectWalls ---
const cfg = { wallMinUsd: 200_000, wallMaxDistPct: 3, wallDominance: 8 };
const bids = Array.from({ length: 50 }, (_, i) => [99 - i * 0.1, 100]); // ~$9.9K levels
bids.push([98.5, 6000]); // ~$591K wall
const asks = Array.from({ length: 50 }, (_, i) => [101 + i * 0.1, 100]);
const walls = detectWalls({ bids, asks, last: 100, ex: "binance", sym: "TEST" }, cfg);
assert.strictEqual(walls.length, 1, "exactly one wall detected");
assert.strictEqual(walls[0].side, "bid");
assert.ok(walls[0].usd > 500_000);
assert.ok(walls[0].dist < 2);

// far wall excluded
const farBids = [[90, 100000]]; // 10% away
assert.strictEqual(detectWalls({ bids: farBids, asks: [], last: 100, ex: "x", sym: "T" }, cfg).length, 0, "distant wall excluded");

// --- market dedup / best source ---
const m = new Market();
m.upsert("binance", { base: "BTC", sym: "BTCUSDT", last: 100, chg: 1, vol: 5e9, trades: 100 });
m.upsert("bybit",   { base: "BTC", sym: "BTCUSDT", last: 100.2, chg: 1.1, vol: 2e9 });
m.upsert("okx",     { base: "BTC", sym: "BTC-USDT-SWAP", last: 99.9, chg: 0.9, vol: 9e9 });
const btc = m.coins.get("BTC");
assert.strictEqual(m.coins.size, 1, "three exchanges dedup into one coin");
assert.strictEqual(btc.best, "okx", "highest volume wins");
assert.strictEqual(btc.last, 99.9, "price follows best source");
assert.strictEqual(btc.trades, 100, "trade count taken from binance when available");

const snap = m.snapshot();
assert.strictEqual(snap.length, 1);
assert.strictEqual(snap[0].s, "BTC");
assert.strictEqual(snap[0].x, "okx");

console.log("All metric + market tests passed ✔");
