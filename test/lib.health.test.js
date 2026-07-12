import assert from "node:assert";
import http from "node:http";
import { healthPayload, handleHealthRequest } from "../server/lib/health.js";
import { createCounters } from "../server/lib/counters.js";

const counters = createCounters();
counters.inc("ticks", 10);
const startTs = Date.now() - 1000;

const payload = healthPayload(startTs, counters, { exchange: "binance" });
assert.strictEqual(payload.status, "ok");
assert.ok(payload.uptimeMs >= 1000);
assert.deepStrictEqual(payload.counters, { ticks: 10 });
assert.strictEqual(payload.exchange, "binance");
assert.ok(typeof payload.ts === "number");

// handleHealthRequest over a real HTTP round-trip
const server = http.createServer((req, res) => {
  handleHealthRequest(req, res, () => healthPayload(startTs, counters));
});
await new Promise(resolve => server.listen(0, resolve));
const { port } = server.address();

const res = await fetch(`http://localhost:${port}/health`);
assert.strictEqual(res.status, 200);
assert.strictEqual(res.headers.get("content-type"), "application/json");
const body = await res.json();
assert.strictEqual(body.status, "ok");
assert.deepStrictEqual(body.counters, { ticks: 10 });

server.close();
console.log("health tests passed ✔");
