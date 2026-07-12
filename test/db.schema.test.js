import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb } from "../server/db/schema.js";

const EXPECTED_TABLES = ["alert_history", "alerts", "candles"];

function listTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(r => r.name);
}

const db = initDb(":memory:");

const tables = listTables(db);
assert.deepStrictEqual(tables, EXPECTED_TABLES);

// insert + read round-trip on each table
db.prepare("INSERT INTO candles (exchange,symbol,interval,open_time,o,h,l,c,v) VALUES (?,?,?,?,?,?,?,?,?)")
  .run("binance", "BTCUSDT", "5m", 1000, 100, 101, 99, 100.5, 12.3);
assert.strictEqual(db.prepare("SELECT count(*) AS n FROM candles").get().n, 1);

db.prepare("INSERT INTO alerts (base, level, side) VALUES (?,?,?)").run("BTC", 70000, "above");
assert.strictEqual(db.prepare("SELECT count(*) AS n FROM alerts").get().n, 1);

db.prepare("INSERT INTO alert_history (kind, sym, msg, ts) VALUES (?,?,?,?)")
  .run("price", "BTC", "BTC crossed 70000", Date.now());
assert.strictEqual(db.prepare("SELECT count(*) AS n FROM alert_history").get().n, 1);

// basic sanity: initDb also works against a second, independent in-memory database
const db2 = initDb(":memory:");
assert.deepStrictEqual(listTables(db2), EXPECTED_TABLES);

db.close();
db2.close();

// idempotent: calling initDb again on the SAME on-disk file must not throw,
// must not duplicate/wipe tables, and must preserve previously inserted data.
// (":memory:" can't prove this — each ":memory:" open is an independent, private
// database, so reusing it never actually re-applies DDL to existing data.)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapeboard-db-schema-test-"));
const tmpFile = path.join(tmpDir, "reuse.sqlite");
try {
  const fileDb1 = initDb(tmpFile);
  assert.deepStrictEqual(listTables(fileDb1), EXPECTED_TABLES);

  fileDb1.prepare("INSERT INTO candles (exchange,symbol,interval,open_time,o,h,l,c,v) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("binance", "ETHUSDT", "1m", 2000, 200, 202, 198, 201, 5.5);
  assert.strictEqual(fileDb1.prepare("SELECT count(*) AS n FROM candles").get().n, 1);
  fileDb1.close();

  // reopen the SAME file: this is the real idempotency test
  const fileDb2 = initDb(tmpFile);
  assert.deepStrictEqual(listTables(fileDb2), EXPECTED_TABLES);
  assert.strictEqual(fileDb2.prepare("SELECT count(*) AS n FROM candles").get().n, 1);
  const row = fileDb2.prepare("SELECT * FROM candles WHERE symbol = ?").get("ETHUSDT");
  assert.ok(row, "row inserted before the second initDb() call must still be present");
  assert.strictEqual(row.exchange, "binance");
  assert.strictEqual(row.open_time, 2000);

  fileDb2.close();
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("db schema tests passed ✔");
