import assert from "node:assert";
import { initDb } from "../server/db/schema.js";

const db = initDb(":memory:");

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  .map(r => r.name);
assert.deepStrictEqual(tables, ["alert_history", "alerts", "candles"]);

// insert + read round-trip on each table
db.prepare("INSERT INTO candles (exchange,symbol,interval,open_time,o,h,l,c,v) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("binance", "BTCUSDT", "5m", 1000, 100, 101, 99, 100.5, 12.3);
assert.strictEqual(db.prepare("SELECT count(*) AS n FROM candles").get().n, 1);

db.prepare("INSERT INTO alerts (base, level, side) VALUES (?,?,?)").run("BTC", 70000, "above");
assert.strictEqual(db.prepare("SELECT count(*) AS n FROM alerts").get().n, 1);

db.prepare("INSERT INTO alert_history (kind, sym, msg, ts) VALUES (?,?,?,?)")
  .run("price", "BTC", "BTC crossed 70000", Date.now());
assert.strictEqual(db.prepare("SELECT count(*) AS n FROM alert_history").get().n, 1);

// idempotent: calling initDb again on the same file must not throw or duplicate tables
const db2 = initDb(":memory:");
const tables2 = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  .map(r => r.name);
assert.deepStrictEqual(tables2, ["alert_history", "alerts", "candles"]);

console.log("db schema tests passed ✔");
