# Board View: Data & Logic Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the testable backend endpoint and pure client-side logic (candle aggregation, metrics, pagination/filter/tag helpers, trend-line detection) that the Board View UI (a separate, later plan) will be wired on top of.

**Architecture:** One new backend module (`server/core/candleApi.js`) exposing an on-demand, cached candle-fetch HTTP route, wired into the existing `server/index.js`. One new frontend pure-function module (`web/lib/metrics.js`) with zero DOM/canvas dependencies, fully unit-testable in Node exactly like `server/core/metrics.js` already is. No UI/rendering/wiring work happens in this plan — that's Plan 2, written after this one is reviewed, so it can build on these interfaces as fixed contracts.

**Tech Stack:** Plain Node.js/ESM, `node:assert` tests (no framework), zero new dependencies.

## Global Constraints

- Node >=20, ESM only (`"type": "module"`) — no CommonJS `require`.
- No test framework: tests are plain scripts using `node:assert`, run via `node test/<name>.test.js`, matching `test/metrics.test.js`'s existing style exactly.
- Zero new dependencies for this plan — the candle cache is a plain `Map`, no new package.
- Match existing code style: no comments except where genuinely non-obvious (see `server/core/market.js`/`metrics.js` for house style).
- Files touched: `server/core/candleApi.js` (new), `server/index.js` (modify — wire the route), `web/lib/metrics.js` (new, built up across tasks 2-5), `test/server.candles.test.js` (new), `test/web.metrics.test.js` (new, built up across tasks 2-5).
- Per `docs/superpowers/specs/2026-07-12-board-view-design.md` section 5: the candle endpoint must reuse the existing exchange connectors' `fetchKlines(sym, interval, limit)` — already implemented generically in `server/exchanges/{binance,bybit,okx,mock}.js` — not add new exchange-integration code.

---

### Task 1: Backend `/api/candles` endpoint + cache

**Files:**
- Create: `server/core/candleApi.js`
- Modify: `server/index.js`
- Test: `test/server.candles.test.js`

**Interfaces:**
- Produces: `createCandleCache(ttlMs = 45_000)` → `{ get(key), set(key, data) }`. `get` returns `null` for a miss or expired entry.
- Produces: `createCandleHandler(market, connectors, cache)` → an async `(req, res) => void` request handler suitable for mounting directly in `http.createServer`'s callback. Looks up `market.coins.get(symbol)`, uses `coin.best` + `coin.sources[best].sym` to find the right connector, calls `connectors[best].fetchKlines(sym, interval, limit)`, caches the result keyed by `${exchange}:${sym}:${interval}:${limit}`, returns JSON. Responds `404` for an unknown symbol, `502` if the source/connector is missing or the fetch throws.
- Consumes: `Market` from `server/core/market.js` (existing), the exchange connector modules' existing `fetchKlines` export, `server/exchanges/mock.js` (existing, used only in the test).

- [ ] **Step 1: Write the failing test**

```js
// test/server.candles.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/server.candles.test.js`
Expected: FAIL — `Cannot find module '../server/core/candleApi.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// server/core/candleApi.js
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
    const limit = Math.min(+(u.searchParams.get("limit") || 60) || 60, 500);

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
    let candles = cache.get(key);
    if (!candles) {
      try {
        candles = await conn.fetchKlines(info.sym, interval, limit);
      } catch {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "fetch failed" }));
        return;
      }
      cache.set(key, candles);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(candles));
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/server.candles.test.js`
Expected: `candle api tests passed ✔`

- [ ] **Step 5: Wire the route into the real server**

Edit `server/index.js`: add the import near the other `core/*` imports:

```js
import { createCandleCache, createCandleHandler } from "./core/candleApi.js";
```

Add the cache + handler alongside the other wiring (after `const engine = new AlertEngine(...)` block, before the `startKlineLoop`/`startDensityLoop` calls is fine — anywhere after `market`/`connectors` exist):

```js
const candleCache = createCandleCache(45_000);
const candleHandler = createCandleHandler(market, connectors, candleCache);
```

Add the route check inside the existing `http.createServer` callback, right after the `/api/snapshot` block:

```js
  if (u.pathname === "/api/candles") {
    candleHandler(req, res);
    return;
  }
```

- [ ] **Step 6: Manually verify the live route**

Run: `npm run mock` (in one terminal), then in another:
```
curl "http://localhost:8080/api/candles?symbol=BTC&interval=5m&limit=5"
```
Expected: a JSON array of 5 `{h,l,c}` objects. Stop the mock server after checking (Ctrl+C).

- [ ] **Step 7: Wire into the test script and commit**

Edit `package.json`'s `"test"` script to append the new test file:

```json
    "test": "node test/metrics.test.js && node test/lib.channels.test.js && node test/lib.counters.test.js && node test/lib.logger.test.js && node test/lib.redis.test.js && node test/lib.health.test.js && node test/db.schema.test.js && node test/server.candles.test.js",
```

```bash
git add server/core/candleApi.js server/index.js test/server.candles.test.js package.json
git commit -m "feat: add /api/candles on-demand endpoint with short-TTL cache"
```

---

### Task 2: `web/lib/metrics.js` — candle bar aggregation from ticks

**Files:**
- Create: `web/lib/metrics.js`
- Create: `test/web.metrics.test.js`

**Interfaces:**
- Produces: `createBarAggregator(intervalMs, maxBars = 200)` → `{ addTick(symbol, ts, price, vol = 0), getBars(symbol), reset() }`. `addTick` buckets `ts` into `Math.floor(ts / intervalMs) * intervalMs`-aligned bars; a new bucket closes the previous bar and opens a new one whose `o` equals the previous bar's `c`. Each bar is `{ t, o, h, l, c, v }`. `getBars` returns the bar array for a symbol (empty array if unknown). Bar history per symbol is capped at `maxBars` (oldest dropped). `reset()` clears all symbols' state.
- This file has no DOM/canvas/network dependency — pure functions/closures only, importable both by the browser (`<script type="module">`) and directly by Node test scripts.

- [ ] **Step 1: Write the failing test**

```js
// test/web.metrics.test.js
import assert from "node:assert";
import { createBarAggregator } from "../web/lib/metrics.js";

// --- single tick creates one bar ---
{
  const agg = createBarAggregator(60_000);
  agg.addTick("BTC", 1_000, 100);
  const bars = agg.getBars("BTC");
  assert.strictEqual(bars.length, 1);
  assert.deepStrictEqual(bars[0], { t: 0, o: 100, h: 100, l: 100, c: 100, v: 0 });
}

// --- ticks within the same bar update h/l/c, o stays fixed, volume accumulates ---
{
  const agg = createBarAggregator(60_000);
  agg.addTick("BTC", 1_000, 100, 5);
  agg.addTick("BTC", 2_000, 105, 3);
  agg.addTick("BTC", 3_000, 98, 2);
  const bars = agg.getBars("BTC");
  assert.strictEqual(bars.length, 1, "still one bar, same 60s bucket");
  assert.strictEqual(bars[0].o, 100);
  assert.strictEqual(bars[0].h, 105);
  assert.strictEqual(bars[0].l, 98);
  assert.strictEqual(bars[0].c, 98);
  assert.strictEqual(bars[0].v, 10);
}

// --- crossing a bar boundary closes the old bar, opens a new one with o = previous c ---
{
  const agg = createBarAggregator(60_000);
  agg.addTick("BTC", 1_000, 100);
  agg.addTick("BTC", 65_000, 110); // next 60s bucket
  const bars = agg.getBars("BTC");
  assert.strictEqual(bars.length, 2);
  assert.strictEqual(bars[0].c, 100);
  assert.strictEqual(bars[1].o, 100, "new bar opens at previous bar's close");
  assert.strictEqual(bars[1].c, 110);
}

// --- bar history capped at maxBars, oldest dropped ---
{
  const agg = createBarAggregator(1_000, 3);
  for (let i = 0; i < 5; i++) agg.addTick("BTC", i * 1_000, 100 + i);
  const bars = agg.getBars("BTC");
  assert.strictEqual(bars.length, 3, "capped at maxBars");
  assert.strictEqual(bars[0].o, 101, "oldest two bars dropped");
}

// --- unknown symbol returns empty array ---
{
  const agg = createBarAggregator(60_000);
  assert.deepStrictEqual(agg.getBars("NOPE"), []);
}

// --- symbols are independent ---
{
  const agg = createBarAggregator(60_000);
  agg.addTick("BTC", 1_000, 100);
  agg.addTick("ETH", 1_000, 2000);
  assert.strictEqual(agg.getBars("BTC").length, 1);
  assert.strictEqual(agg.getBars("ETH").length, 1);
  assert.strictEqual(agg.getBars("BTC")[0].o, 100);
  assert.strictEqual(agg.getBars("ETH")[0].o, 2000);
}

// --- reset() clears all state ---
{
  const agg = createBarAggregator(60_000);
  agg.addTick("BTC", 1_000, 100);
  agg.reset();
  assert.deepStrictEqual(agg.getBars("BTC"), []);
}

console.log("web metrics (bar aggregation) tests passed ✔");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/web.metrics.test.js`
Expected: FAIL — `Cannot find module '../web/lib/metrics.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// web/lib/metrics.js
export function createBarAggregator(intervalMs, maxBars = 200) {
  const state = new Map(); // symbol -> { bars: [...] }

  function addTick(symbol, ts, price, vol = 0) {
    let s = state.get(symbol);
    if (!s) { s = { bars: [] }; state.set(symbol, s); }
    const bars = s.bars;
    const start = Math.floor(ts / intervalMs) * intervalMs;
    let cur = bars[bars.length - 1];
    if (!cur || cur.t !== start) {
      const o = cur ? cur.c : price;
      cur = { t: start, o, h: price, l: price, c: price, v: 0 };
      bars.push(cur);
      if (bars.length > maxBars) bars.shift();
    }
    cur.h = Math.max(cur.h, price);
    cur.l = Math.min(cur.l, price);
    cur.c = price;
    cur.v += vol;
    return cur;
  }

  function getBars(symbol) {
    return state.get(symbol)?.bars || [];
  }

  function reset() {
    state.clear();
  }

  return { addTick, getBars, reset };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/web.metrics.test.js`
Expected: `web metrics (bar aggregation) tests passed ✔`

- [ ] **Step 5: Wire into the test script and commit**

```json
    "test": "... && node test/server.candles.test.js && node test/web.metrics.test.js",
```
(append `node test/web.metrics.test.js` to the existing chain from Task 1)

```bash
git add web/lib/metrics.js test/web.metrics.test.js package.json
git commit -m "feat: add client-side OHLC bar aggregation from live ticks"
```

---

### Task 3: `web/lib/metrics.js` — `natr`/`avgRange` client copies

**Files:**
- Modify: `web/lib/metrics.js`
- Modify: `test/web.metrics.test.js`

**Interfaces:**
- Produces: `natr(candles)` and `avgRange(candles)`, added as new exports alongside `createBarAggregator`. These must be **byte-identical in behavior** to `server/core/metrics.js`'s `natr`/`avgRange` (same formulas, same edge-case handling for `<2` candles / empty / null) — this is a client-side copy of the exact same pure logic, per the design spec, not a reinterpretation.

- [ ] **Step 1: Write the failing test**

Append to `test/web.metrics.test.js` (before the final `console.log` line):

```js
import { natr, avgRange } from "../web/lib/metrics.js"; // add to the existing import line instead of a new one

// --- natr / avgRange: same behavior as server/core/metrics.js ---
{
  const flat = Array.from({ length: 15 }, () => ({ h: 100, l: 100, c: 100 }));
  assert.strictEqual(natr(flat), 0, "flat candles -> NATR 0");

  const oneRange = [{ h: 100, l: 100, c: 100 }, { h: 101, l: 99, c: 100 }];
  assert.ok(Math.abs(natr(oneRange) - 2) < 1e-9, "single 2-wide candle on 100 -> 2%");
  assert.strictEqual(natr([]), null);
  assert.strictEqual(natr(null), null);

  assert.ok(Math.abs(avgRange([{ h: 101, l: 100, c: 100.5 }]) - 1) < 1e-9, "1% range");
  assert.strictEqual(avgRange([]), null);
}
```

(Note: move the `import { createBarAggregator } from "../web/lib/metrics.js";` at the top of the file to `import { createBarAggregator, natr, avgRange } from "../web/lib/metrics.js";` instead of adding a second import line.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/web.metrics.test.js`
Expected: FAIL — `natr is not a function` (or similar — `natr`/`avgRange` not yet exported)

- [ ] **Step 3: Write minimal implementation**

Append to `web/lib/metrics.js` (exact copy of `server/core/metrics.js`'s two functions):

```js
export function natr(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  let sum = 0, n = 0;
  for (let i = 1; i < candles.length; i++) {
    const { h, l } = candles[i], pc = candles[i - 1].c;
    if (!(h > 0 && l > 0 && pc > 0)) continue;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    n++;
  }
  const last = candles[candles.length - 1].c;
  return n && last > 0 ? (sum / n) / last * 100 : null;
}

export function avgRange(candles) {
  if (!Array.isArray(candles) || !candles.length) return null;
  let s = 0, n = 0;
  for (const k of candles) {
    if (k.l > 0 && k.h >= k.l) { s += (k.h - k.l) / k.l * 100; n++; }
  }
  return n ? s / n : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/web.metrics.test.js`
Expected: `web metrics (bar aggregation) tests passed ✔` (still — same final log line, new assertions run silently before it)

- [ ] **Step 5: Commit**

```bash
git add web/lib/metrics.js test/web.metrics.test.js
git commit -m "feat: add client-side natr/avgRange (mirrors server/core/metrics.js)"
```

---

### Task 4: `web/lib/metrics.js` — filter/sort/pagination helpers

**Files:**
- Modify: `web/lib/metrics.js`
- Modify: `test/web.metrics.test.js`

**Interfaces:**
- Produces: `selectCoins(coins, opts)` — `opts = { minVol = 0, searchQ = "", tagFilter = "all", tags = new Map(), sortKey = "v", sortDir = -1 }`. Filters `coins` (array of snapshot-shaped objects with `.s`/`.v`/etc., matching `Market.snapshot()`'s wire shape) by `minVol`, then by `tagFilter` (skipped if `"all"`, else keeps only coins where `tags.get(c.s) === tagFilter`), then by `searchQ` (substring match on `.s`), then sorts by `sortKey`/`sortDir` (string compare for `"s"`, numeric otherwise, missing values sort last). Returns a new array; does not mutate the input.
- Produces: `paginate(list, page, pageSize)` → `list.slice(page * pageSize, page * pageSize + pageSize)`.
- Produces: `pageCount(listLength, pageSize)` → `Math.max(1, Math.ceil(listLength / pageSize))`.
- This is the single shared filter/sort/page logic the Board grid and the Coin List sidebar will both call (per design spec section 4 — "the grid is a different rendering of the same filtered/sorted list"), and the same logic the existing screener table's `visible()` function in `web/index.html` should eventually be replaced by (that replacement happens in Plan 2, not here).

- [ ] **Step 1: Write the failing test**

Append to `test/web.metrics.test.js` (add `selectCoins, paginate, pageCount` to the existing import line):

```js
// --- selectCoins: filter + sort ---
{
  const coins = [
    { s: "BTC", v: 5e9, c: 1.2 },
    { s: "ETH", v: 2e9, c: -0.5 },
    { s: "SOL", v: 8e8, c: 3.1 },
    { s: "DOGE", v: 1e6, c: 0.1 }
  ];

  // minVol filter
  let out = selectCoins(coins, { minVol: 1e9 });
  assert.deepStrictEqual(out.map(c => c.s).sort(), ["BTC", "ETH"]);

  // search filter
  out = selectCoins(coins, { searchQ: "SO" });
  assert.deepStrictEqual(out.map(c => c.s), ["SOL"]);

  // sort by volume descending (default)
  out = selectCoins(coins, {});
  assert.deepStrictEqual(out.map(c => c.s), ["BTC", "ETH", "SOL", "DOGE"]);

  // sort by symbol ascending
  out = selectCoins(coins, { sortKey: "s", sortDir: 1 });
  assert.deepStrictEqual(out.map(c => c.s), ["BTC", "DOGE", "ETH", "SOL"]);

  // tag filter
  const tags = new Map([["BTC", "green"], ["ETH", "red"]]);
  out = selectCoins(coins, { tagFilter: "green", tags });
  assert.deepStrictEqual(out.map(c => c.s), ["BTC"]);

  // does not mutate input
  selectCoins(coins, { sortKey: "s", sortDir: 1 });
  assert.strictEqual(coins[0].s, "BTC", "original array order untouched");
}

// --- paginate / pageCount ---
{
  const list = [1, 2, 3, 4, 5, 6, 7];
  assert.deepStrictEqual(paginate(list, 0, 3), [1, 2, 3]);
  assert.deepStrictEqual(paginate(list, 1, 3), [4, 5, 6]);
  assert.deepStrictEqual(paginate(list, 2, 3), [7]);
  assert.strictEqual(pageCount(7, 3), 3);
  assert.strictEqual(pageCount(9, 3), 3);
  assert.strictEqual(pageCount(0, 3), 1, "zero items still reports 1 page");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/web.metrics.test.js`
Expected: FAIL — `selectCoins is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `web/lib/metrics.js`:

```js
export function selectCoins(coins, opts = {}) {
  const { minVol = 0, searchQ = "", tagFilter = "all", tags = new Map(), sortKey = "v", sortDir = -1 } = opts;
  let list = coins.filter(c => c.v >= minVol);
  if (tagFilter !== "all") list = list.filter(c => tags.get(c.s) === tagFilter);
  if (searchQ) list = list.filter(c => c.s.includes(searchQ));
  list = list.slice().sort((a, b) => {
    if (sortKey === "s") return sortDir * (a.s < b.s ? -1 : a.s > b.s ? 1 : 0);
    const va = a[sortKey] ?? -1e18, vb = b[sortKey] ?? -1e18;
    return sortDir * (va - vb);
  });
  return list;
}

export function paginate(list, page, pageSize) {
  const start = page * pageSize;
  return list.slice(start, start + pageSize);
}

export function pageCount(listLength, pageSize) {
  return Math.max(1, Math.ceil(listLength / pageSize));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/web.metrics.test.js`
Expected: `web metrics (bar aggregation) tests passed ✔`

- [ ] **Step 5: Commit**

```bash
git add web/lib/metrics.js test/web.metrics.test.js
git commit -m "feat: add selectCoins/paginate/pageCount shared filter-sort-page helpers"
```

---

### Task 5: `web/lib/metrics.js` — trend-line detection (best-fit swing-point selection)

**Files:**
- Modify: `web/lib/metrics.js`
- Modify: `test/web.metrics.test.js`

**Interfaces:**
- Produces: `findTrendLine(bars, kind, { window = 2, tolerancePct = 0.0015 } = {})` — `kind` is `"high"` (resistance) or `"low"` (support). `bars` is the same `{t,o,h,l,c,v}` array shape `createBarAggregator` produces. Returns `null` if fewer than 2 swing points exist, or if every candidate pair is invalidated. Otherwise returns `{ p1: {i,v}, p2: {i,v}, touches, valueAt(i) }` for the winning candidate — the swing-point pair with the most other swing points within `tolerancePct` of the line, excluding any candidate a later close price breaks through.
- Produces: `findTrendLines(bars, opts)` → `{ resistance: findTrendLine(bars, "high", opts), support: findTrendLine(bars, "low", opts) }`.
- Algorithm (per design spec section 3): (1) a bar is a swing high/low if its `h`/`l` exceeds/is-exceeded-by the `window` bars on each side; (2) every pair of swing points forms a candidate line; (3) a candidate's score is how many *other* swing points fall within `tolerancePct` of the line's value at their index; (4) a candidate is invalid if any bar's `c` from `min(p1.i, p2.i)` onward breaks through it (resistance: close > line value scaled by `(1 + tolerancePct)`; support: close < line value scaled by `(1 - tolerancePct)`); (5) the valid candidate with the highest score wins, ties broken toward the pair with the larger `p2.i`.

- [ ] **Step 1: Write the failing test**

Append to `test/web.metrics.test.js` (add `findTrendLine, findTrendLines` to the existing import line):

```js
// --- trend lines: best-fit selection over 3 perfectly colinear swing lows ---
{
  // lows chosen so swing lows (dips) occur at exactly i=3 (100), i=7 (103),
  // i=11 (106) — colinear (slope 0.75/index).
  const lows = [150, 140, 130, 100, 130, 140, 145, 103, 145, 140, 130, 106, 140, 150, 160];
  const bars = lows.map(l => ({ t: 0, o: l + 10, h: l + 30, l, c: l + 15, v: 0 }));

  const support = findTrendLine(bars, "low");
  assert.ok(support, "support line found");
  assert.strictEqual(support.p1.i, 3);
  assert.strictEqual(support.p2.i, 11, "ties broken toward the more recent (larger index) point");
  assert.strictEqual(support.touches, 1, "the middle swing low (i=7) touches this line");
  assert.ok(Math.abs(support.valueAt(7) - 103) < 1e-9);
}

// --- trend lines: best-fit selection over 3 perfectly colinear swing highs ---
{
  // Dedicated peaks fixture (NOT the dip fixture shifted by a constant — shifting
  // preserves local MINIMA, not maxima, so it would never produce swing highs).
  // Swing highs occur at exactly i=3 (100), i=7 (103), i=11 (106) — colinear.
  const highs = [50, 60, 70, 100, 70, 60, 65, 103, 65, 60, 70, 106, 60, 50, 40];
  const bars = highs.map(h => ({ t: 0, o: h - 20, h, l: h - 30, c: h - 15, v: 0 }));

  const { resistance } = findTrendLines(bars);
  assert.ok(resistance, "resistance line found");
  assert.strictEqual(resistance.p1.i, 3);
  assert.strictEqual(resistance.p2.i, 11);
  assert.strictEqual(resistance.touches, 1);
}

// --- trend lines: a candidate invalidated by a close breaking through must be rejected ---
{
  // Exactly 2 swing lows (i=2 -> 100, i=7 -> 120), the only possible candidate.
  // bars[4].c is set to 90, well below the line's value at i=4 (108) — this
  // must disqualify the only candidate, so the result is null.
  const l = [150, 130, 100, 130, 115, 125, 128, 120, 140, 150];
  const c = [160, 140, 110, 140, 90, 128, 132, 130, 150, 160];
  const h = [170, 150, 120, 150, 135, 138, 142, 140, 160, 170];
  const o = [165, 145, 115, 145, 120, 123, 127, 125, 155, 165];
  const bars = l.map((v, i) => ({ t: 0, o: o[i], h: h[i], l: v, c: c[i], v: 0 }));

  const support = findTrendLine(bars, "low");
  assert.strictEqual(support, null, "the only candidate line is broken by bars[4].c, so no valid line exists");
}

// --- too few bars/swing points -> null ---
{
  const bars = [{ t: 0, o: 100, h: 101, l: 99, c: 100, v: 0 }];
  assert.strictEqual(findTrendLine(bars, "low"), null);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/web.metrics.test.js`
Expected: FAIL — `findTrendLine is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `web/lib/metrics.js`:

```js
function findSwingPoints(bars, kind, window) {
  const field = kind === "high" ? "h" : "l";
  const points = [];
  for (let i = window; i < bars.length - window; i++) {
    const v = bars[i][field];
    let isSwing = true;
    for (let k = 1; k <= window; k++) {
      const left = bars[i - k][field], right = bars[i + k][field];
      const ok = kind === "high" ? (v > left && v > right) : (v < left && v < right);
      if (!ok) { isSwing = false; break; }
    }
    if (isSwing) points.push({ i, v });
  }
  return points;
}

function lineValueAt(p1, p2, i) {
  const slope = (p2.v - p1.v) / (p2.i - p1.i);
  return p1.v + slope * (i - p1.i);
}

function scoreCandidate(p1, p2, points, tolerancePct) {
  let touches = 0;
  for (const p of points) {
    if (p === p1 || p === p2) continue;
    const expected = lineValueAt(p1, p2, p.i);
    if (expected > 0 && Math.abs(p.v - expected) / expected <= tolerancePct) touches++;
  }
  return touches;
}

function isValidCandidate(p1, p2, bars, kind, tolerancePct) {
  const startI = Math.min(p1.i, p2.i);
  for (let i = startI; i < bars.length; i++) {
    const expected = lineValueAt(p1, p2, i);
    const close = bars[i].c;
    if (kind === "high") {
      if (close > expected * (1 + tolerancePct)) return false;
    } else {
      if (close < expected * (1 - tolerancePct)) return false;
    }
  }
  return true;
}

export function findTrendLine(bars, kind, { window = 2, tolerancePct = 0.0015 } = {}) {
  const points = findSwingPoints(bars, kind, window);
  if (points.length < 2) return null;

  let best = null;
  for (let a = 0; a < points.length; a++) {
    for (let b = a + 1; b < points.length; b++) {
      const p1 = points[a], p2 = points[b];
      if (!isValidCandidate(p1, p2, bars, kind, tolerancePct)) continue;
      const score = scoreCandidate(p1, p2, points, tolerancePct);
      if (!best || score > best.score || (score === best.score && p2.i > best.p2.i)) {
        best = { p1, p2, score };
      }
    }
  }
  if (!best) return null;

  return {
    p1: best.p1,
    p2: best.p2,
    touches: best.score,
    valueAt: i => lineValueAt(best.p1, best.p2, i)
  };
}

export function findTrendLines(bars, opts) {
  return {
    resistance: findTrendLine(bars, "high", opts),
    support: findTrendLine(bars, "low", opts)
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/web.metrics.test.js`
Expected: `web metrics (bar aggregation) tests passed ✔`

If either fixture-based assertion fails due to an arithmetic slip in the hand-derived bar values, recompute the intended swing points/line values from the fixture as written and adjust the fixture's numbers (not the algorithm) until it exercises the four properties the test names: correct swing-point detection, touch-count scoring, validity-filter rejection, and highest-score-wins-with-recency-tiebreak selection. Don't weaken an assertion to make it pass.

- [ ] **Step 5: Commit**

```bash
git add web/lib/metrics.js test/web.metrics.test.js
git commit -m "feat: add best-fit support/resistance trend-line detection"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all test files (including the new `server.candles.test.js` and `web.metrics.test.js`) print their `passed ✔` line, exit code 0.

- [ ] **Step 2: Confirm no stray files**

Run: `git status`
Expected: working tree clean.

## What This Unblocks

Plan 2 (Board View UI — written after this plan is reviewed) will:
- Split `web/index.html`'s inline script into `web/app.js` + `web/lib/chart.js`, importing `createBarAggregator`, `natr`, `avgRange`, `selectCoins`, `paginate`, `pageCount`, `findTrendLines` from this plan's `web/lib/metrics.js` as fixed, already-tested contracts.
- Add the Board tab (collapsible left sidebar, chart grid on the right, 3/6/9 pagination), the canvas chart renderer, the sidebar panels (Coin List/Density Map/Listings), color tagging, and the NATR/Range period UI wired to this plan's `/api/candles` endpoint.
- All of that work is UI/DOM/canvas — verified manually (`npm run mock` + browser), not by automated tests, per the design spec's Testing section.
