import assert from "node:assert";
import { CHANNELS } from "../server/lib/channels.js";

assert.strictEqual(CHANNELS.ticks("binance"), "ticks:binance");
assert.strictEqual(CHANNELS.klines("okx"), "klines:okx");
assert.strictEqual(CHANNELS.depth("bybit", "BTCUSDT"), "depth:bybit:BTCUSDT");
assert.strictEqual(CHANNELS.ctrl("binance"), "ctrl:binance");
assert.strictEqual(CHANNELS.snap, "snap");
assert.strictEqual(CHANNELS.density, "density");
assert.strictEqual(CHANNELS.alerts, "alerts");
assert.strictEqual(CHANNELS.cmdAlerts, "cmd:alerts");

console.log("channels tests passed ✔");
