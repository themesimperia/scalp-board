# Shared Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the small shared library modules (logging, Redis pub/sub, counters, health endpoint, SQLite schema) that every one of TapeBoard's six upcoming services depends on.

**Architecture:** Plain ESM modules under `server/lib/` and `server/db/`, each with a single responsibility, no framework beyond the three new dependencies. No services are built in this plan — this is pure shared-library scaffolding, testable in isolation, exactly like the existing `server/core/metrics.js`.

**Tech Stack:** Node.js (ESM), `pino` (structured logging), `ioredis` (Redis client) + `ioredis-mock` (test double), `better-sqlite3` (embedded persistence).

## Global Constraints

- Node >=20, ESM only (`"type": "module"` in package.json) — no CommonJS `require`. (Raised from >=18 during Task 1: `better-sqlite3@^12.11.1` has no prebuilt binary for Node 18/19 on this machine's ABI.)
- No test framework: tests are plain scripts using `node:assert`, run via `node test/<name>.test.js`, matching the existing `test/metrics.test.js` style exactly — no Jest/Mocha/Vitest.
- Only four new dependencies total for this plan: `pino`, `ioredis`, `better-sqlite3` (runtime), `ioredis-mock` (dev/test only). Do not add anything else without going back to the spec.
- Match existing code style: no comments except where something is genuinely non-obvious (see `server/core/market.js` for the house style — short doc comments above exported functions, nothing inline explaining the obvious).
- All new shared modules live under `server/lib/` (logger, redis, counters, health, channels) or `server/db/` (schema). Later plans (ingestion/aggregator/gateway services) import from here — do not duplicate this logic in a service.

---

### Task 1: Add new dependencies

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `pino`, `ioredis`, `better-sqlite3` importable from any ESM module in the project; `ioredis-mock` importable in test files.

- [ ] **Step 1: Add dependencies to package.json**

Edit `package.json`'s `dependencies` and add a `devDependencies` block:

```json
  "dependencies": {
    "ws": "^8.18.0",
    "pino": "^9.5.0",
    "ioredis": "^5.4.1",
    "better-sqlite3": "^12.11.1"
  },
  "devDependencies": {
    "ioredis-mock": "^8.9.0"
  },
```

- [ ] **Step 2: Install and verify**

Run: `npm install`
Expected: exits 0, `node_modules/pino`, `node_modules/ioredis`, `node_modules/better-sqlite3`, `node_modules/ioredis-mock` all exist.

Run: `node -e "import('pino').then(()=>import('ioredis')).then(()=>import('better-sqlite3')).then(()=>import('ioredis-mock')).then(()=>console.log('all ok'))"`
Expected output: `all ok`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add pino, ioredis, better-sqlite3, ioredis-mock"
```

---

### Task 2: Redis channel name constants

**Files:**
- Create: `server/lib/channels.js`
- Test: `test/lib.channels.test.js`

**Interfaces:**
- Produces: `CHANNELS` object — `CHANNELS.ticks(exchange)`, `CHANNELS.klines(exchange)`, `CHANNELS.depth(exchange, symbol)`, `CHANNELS.ctrl(exchange)` (functions returning channel name strings), plus static string channels `CHANNELS.snap`, `CHANNELS.density`, `CHANNELS.alerts`, `CHANNELS.cmdAlerts`.

- [ ] **Step 1: Write the failing test**

```js
// test/lib.channels.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/lib.channels.test.js`
Expected: FAIL — `Cannot find module '../server/lib/channels.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// server/lib/channels.js
export const CHANNELS = {
  ticks: exchange => `ticks:${exchange}`,
  klines: exchange => `klines:${exchange}`,
  depth: (exchange, symbol) => `depth:${exchange}:${symbol}`,
  ctrl: exchange => `ctrl:${exchange}`,
  snap: "snap",
  density: "density",
  alerts: "alerts",
  cmdAlerts: "cmd:alerts"
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/lib.channels.test.js`
Expected: `channels tests passed ✔`

- [ ] **Step 5: Wire into the test script and commit**

Edit `package.json`'s `"test"` script to chain the new file:

```json
    "test": "node test/metrics.test.js && node test/lib.channels.test.js",
```

```bash
git add server/lib/channels.js test/lib.channels.test.js package.json
git commit -m "feat: add Redis channel name constants"
```

---

### Task 3: Counters registry

**Files:**
- Create: `server/lib/counters.js`
- Test: `test/lib.counters.test.js`

**Interfaces:**
- Produces: `createCounters()` returning `{ inc(name, by = 1), set(name, value), snapshot() }`. `snapshot()` returns a plain object merging all counters and gauges by name. Used by every service's `/health` payload (Task 6) and by ingestion/aggregator/gateway internals in later plans to track messages/sec, reconnects, errors, client counts.

- [ ] **Step 1: Write the failing test**

```js
// test/lib.counters.test.js
import assert from "node:assert";
import { createCounters } from "../server/lib/counters.js";

const c = createCounters();
c.inc("ticks");
c.inc("ticks");
c.inc("ticks", 3);
c.set("clients", 7);
assert.deepStrictEqual(c.snapshot(), { ticks: 5, clients: 7 });

const c2 = createCounters();
assert.deepStrictEqual(c2.snapshot(), {}, "empty registry snapshots to {}");

console.log("counters tests passed ✔");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/lib.counters.test.js`
Expected: FAIL — `Cannot find module '../server/lib/counters.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// server/lib/counters.js
export function createCounters() {
  const counts = new Map();
  const gauges = new Map();
  return {
    inc(name, by = 1) { counts.set(name, (counts.get(name) || 0) + by); },
    set(name, value) { gauges.set(name, value); },
    snapshot() {
      return { ...Object.fromEntries(counts), ...Object.fromEntries(gauges) };
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/lib.counters.test.js`
Expected: `counters tests passed ✔`

- [ ] **Step 5: Wire into the test script and commit**

```json
    "test": "node test/metrics.test.js && node test/lib.channels.test.js && node test/lib.counters.test.js",
```

```bash
git add server/lib/counters.js test/lib.counters.test.js package.json
git commit -m "feat: add in-process counters/gauges registry"
```

---

### Task 4: Structured logger

**Files:**
- Create: `server/lib/logger.js`
- Test: `test/lib.logger.test.js`

**Interfaces:**
- Produces: `createLogger(service, destination)` returning a `pino` logger instance whose every line includes a `service` field. `destination` is an optional writable stream (defaults to stdout), injected so tests can capture output without touching real stdout.

- [ ] **Step 1: Write the failing test**

```js
// test/lib.logger.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/lib.logger.test.js`
Expected: FAIL — `Cannot find module '../server/lib/logger.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// server/lib/logger.js
import pino from "pino";

export function createLogger(service, destination) {
  return pino({ base: { service }, timestamp: pino.stdTimeFunctions.isoTime }, destination);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/lib.logger.test.js`
Expected: `logger tests passed ✔`

- [ ] **Step 5: Wire into the test script and commit**

```json
    "test": "node test/metrics.test.js && node test/lib.channels.test.js && node test/lib.counters.test.js && node test/lib.logger.test.js",
```

```bash
git add server/lib/logger.js test/lib.logger.test.js package.json
git commit -m "feat: add structured pino logger factory"
```

---

### Task 5: Redis pub/sub wrapper

**Files:**
- Create: `server/lib/redis.js`
- Test: `test/lib.redis.test.js`

**Interfaces:**
- Consumes: `CHANNELS` from Task 2 (test only, for realistic channel names).
- Produces: `createRedisClient(url, RedisImpl)` — `RedisImpl` is an injectable constructor (defaults to the real `ioredis` `Redis` class; tests pass `ioredis-mock`'s default export instead). Returns `{ publish(channel, obj), subscribe(channel, handler), unsubscribe(channel, handler), quit() }`. `publish` JSON-stringifies `obj`; `subscribe`'s `handler` receives the JSON-parsed payload (malformed messages are dropped, not thrown). Every ingestion/aggregator/gateway service in later plans is built on this — the shape must not change.

- [ ] **Step 1: Write the failing test**

```js
// test/lib.redis.test.js
import assert from "node:assert";
import RedisMock from "ioredis-mock";
import { createRedisClient } from "../server/lib/redis.js";
import { CHANNELS } from "../server/lib/channels.js";

const client = createRedisClient("redis://localhost:6379", RedisMock);

const received = [];
await new Promise((resolve) => {
  client.subscribe(CHANNELS.ticks("binance"), payload => {
    received.push(payload);
    resolve();
  });
  // subscribe is async under the hood (ioredis SUBSCRIBE round-trip); wait a tick before publishing
  setTimeout(() => client.publish(CHANNELS.ticks("binance"), { base: "BTC", last: 68000 }), 20);
});

assert.strictEqual(received.length, 1);
assert.deepStrictEqual(received[0], { base: "BTC", last: 68000 });

// unsubscribe stops delivery
let afterUnsub = false;
const handler = () => { afterUnsub = true; };
client.subscribe(CHANNELS.snap, handler);
client.unsubscribe(CHANNELS.snap, handler);
client.publish(CHANNELS.snap, { coins: [] });
await new Promise(r => setTimeout(r, 20));
assert.strictEqual(afterUnsub, false, "handler must not fire after unsubscribe");

await client.quit();
console.log("redis wrapper tests passed ✔");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/lib.redis.test.js`
Expected: FAIL — `Cannot find module '../server/lib/redis.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// server/lib/redis.js
import Redis from "ioredis";

export function createRedisClient(url, RedisImpl = Redis) {
  const pub = new RedisImpl(url);
  const sub = new RedisImpl(url);
  const handlers = new Map(); // channel -> Set<fn>

  sub.on("message", (channel, message) => {
    const set = handlers.get(channel);
    if (!set || !set.size) return;
    let payload;
    try { payload = JSON.parse(message); } catch { return; }
    for (const fn of set) fn(payload);
  });

  return {
    publish(channel, obj) {
      return pub.publish(channel, JSON.stringify(obj));
    },
    subscribe(channel, handler) {
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
        sub.subscribe(channel);
      }
      set.add(handler);
    },
    unsubscribe(channel, handler) {
      const set = handlers.get(channel);
      if (!set) return;
      set.delete(handler);
      if (!set.size) {
        handlers.delete(channel);
        sub.unsubscribe(channel);
      }
    },
    quit() {
      return Promise.all([pub.quit(), sub.quit()]);
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/lib.redis.test.js`
Expected: `redis wrapper tests passed ✔`

- [ ] **Step 5: Wire into the test script and commit**

```json
    "test": "node test/metrics.test.js && node test/lib.channels.test.js && node test/lib.counters.test.js && node test/lib.logger.test.js && node test/lib.redis.test.js",
```

```bash
git add server/lib/redis.js test/lib.redis.test.js package.json
git commit -m "feat: add Redis pub/sub wrapper with injectable client"
```

---

### Task 6: Health payload + request handler

**Files:**
- Create: `server/lib/health.js`
- Test: `test/lib.health.test.js`

**Interfaces:**
- Consumes: `createCounters()`'s `.snapshot()` shape from Task 3.
- Produces: `healthPayload(startTs, counters, extra)` returning `{ status, uptimeMs, counters, ts, ...extra }` (`extra` is an optional plain object for service-specific fields, e.g. per-exchange last-tick timestamps — merged in as-is). `handleHealthRequest(req, res, getPayload)` writes a 200 JSON response from calling `getPayload()`. Every service in later plans mounts `handleHealthRequest` at its `/health` route.

- [ ] **Step 1: Write the failing test**

```js
// test/lib.health.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/lib.health.test.js`
Expected: FAIL — `Cannot find module '../server/lib/health.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// server/lib/health.js
export function healthPayload(startTs, counters, extra = {}) {
  return {
    status: "ok",
    uptimeMs: Date.now() - startTs,
    counters: counters.snapshot(),
    ts: Date.now(),
    ...extra
  };
}

export function handleHealthRequest(req, res, getPayload) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(getPayload()));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/lib.health.test.js`
Expected: `health tests passed ✔`

- [ ] **Step 5: Wire into the test script and commit**

```json
    "test": "node test/metrics.test.js && node test/lib.channels.test.js && node test/lib.counters.test.js && node test/lib.logger.test.js && node test/lib.redis.test.js && node test/lib.health.test.js",
```

```bash
git add server/lib/health.js test/lib.health.test.js package.json
git commit -m "feat: add /health payload builder and request handler"
```

---

### Task 7: SQLite schema and init

**Files:**
- Create: `server/db/schema.js`
- Test: `test/db.schema.test.js`

**Interfaces:**
- Produces: `initDb(pathOrMemory)` — opens a `better-sqlite3` `Database` at the given path (or `":memory:"` for tests), applies the DDL (idempotent — safe to call on an existing database), and returns the raw `Database` instance. The `aggregator` service (a later plan) is the only consumer and does all further query-building itself; this module owns only the schema definition and connection setup.
- Schema: `candles(exchange, symbol, interval, open_time, o, h, l, c, v)` with primary key `(exchange, symbol, interval, open_time)`; `alerts(base, level, side)` with primary key `(base, level)`; `alert_history(id AUTOINCREMENT, kind, sym, msg, ts)` with an index on `ts`.

- [ ] **Step 1: Write the failing test**

```js
// test/db.schema.test.js
import assert from "node:assert";
import { initDb } from "../server/db/schema.js";

const db = initDb(":memory:");

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
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
const tables2 = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  .map(r => r.name);
assert.deepStrictEqual(tables2, ["alert_history", "alerts", "candles"]);

console.log("db schema tests passed ✔");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/db.schema.test.js`
Expected: FAIL — `Cannot find module '../server/db/schema.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// server/db/schema.js
import Database from "better-sqlite3";

const DDL = `
CREATE TABLE IF NOT EXISTS candles (
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  open_time INTEGER NOT NULL,
  o REAL NOT NULL,
  h REAL NOT NULL,
  l REAL NOT NULL,
  c REAL NOT NULL,
  v REAL NOT NULL,
  PRIMARY KEY (exchange, symbol, interval, open_time)
);

CREATE TABLE IF NOT EXISTS alerts (
  base TEXT NOT NULL,
  level REAL NOT NULL,
  side TEXT NOT NULL,
  PRIMARY KEY (base, level)
);

CREATE TABLE IF NOT EXISTS alert_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  sym TEXT NOT NULL,
  msg TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_history_ts ON alert_history (ts);
`;

export function initDb(pathOrMemory) {
  const db = new Database(pathOrMemory);
  if (pathOrMemory !== ":memory:") db.pragma("journal_mode = WAL");
  db.exec(DDL);
  return db;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/db.schema.test.js`
Expected: `db schema tests passed ✔`

- [ ] **Step 5: Wire into the test script and commit**

```json
    "test": "node test/metrics.test.js && node test/lib.channels.test.js && node test/lib.counters.test.js && node test/lib.logger.test.js && node test/lib.redis.test.js && node test/lib.health.test.js && node test/db.schema.test.js",
```

```bash
git add server/db/schema.js test/db.schema.test.js package.json
git commit -m "feat: add SQLite schema for candles/alerts/alert_history"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all seven test files print their `passed ✔` line, exit code 0.

- [ ] **Step 2: Confirm no stray files**

Run: `git status`
Expected: working tree clean (everything already committed per-task).

## What This Unblocks

With this plan complete, the next plans can each `import` from a stable foundation:
- **Plan 2 (ingestion-binance)**, **Plan 3 (ingestion-bybit)**, **Plan 4 (ingestion-okx)** — use `createLogger`, `createRedisClient`, `CHANNELS`, `createCounters`, health helpers.
- **Plan 5 (aggregator)** — additionally uses `initDb`.
- **Plan 6 (gateway)**, **Plan 7 (telegram-notifier)** — use the same logging/redis/health/counters set.
- **Plan 8 (deployment)** — wires all of the above into Dockerfiles/compose once the services exist.

Each of those will be written as its own plan once this one is merged, so lessons from building the foundation (and from Task 1's real dependency install) carry forward accurately.
