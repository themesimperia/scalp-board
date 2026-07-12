import assert from "node:assert";
import { Writable } from "node:stream";
import { createLogger } from "../server/lib/logger.js";

let buf = "";
const sink = new Writable({
  write(chunk, _enc, cb) { buf += chunk.toString(); cb(); }
});

const log = createLogger("test-service", sink);
log.info({ exchange: "binance" }, "tick received");

// pino writes async; give it a tick to flush
await new Promise(r => setTimeout(r, 50));

const line = JSON.parse(buf.trim().split("\n")[0]);
assert.strictEqual(line.service, "test-service");
assert.strictEqual(line.exchange, "binance");
assert.strictEqual(line.msg, "tick received");

console.log("logger tests passed ✔");
