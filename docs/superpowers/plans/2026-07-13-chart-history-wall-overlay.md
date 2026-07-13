# Chart History, Wall Overlay & Timeframe Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chart panels show real historical candles immediately (not a single accumulating candle), overlay the top bid/ask order-book wall as labeled price lines, and offer a full 1m/5m/15m/30m/1h/4h/1d timeframe selector.

**Architecture:** A small backend addition (exchange connectors' `fetchKlines` gains `t`/`o` fields, non-breaking) feeds the already-built `/api/candles` endpoint's existing response through a new `seedBars` method on the already-tested `createBarAggregator`. `web/lib/chart.js`'s pure canvas renderer gains a `walls` param reusing data already flowing over the WebSocket. `web/app.js` wires fetch-on-visible and fetch-on-timeframe-change on top of Task 7's existing timeframe/pagination controls.

**Tech Stack:** Plain Node.js/ESM, `node:assert` tests where automatable, real headless-browser (`playwright-core` + cached Chromium) verification for canvas/DOM work — no new dependencies.

## Global Constraints

- Node >=20, ESM only, no build step, no new dependencies.
- No test framework: tests are plain `node:assert` scripts.
- Match existing code style: no comments except where genuinely non-obvious.
- This plan's UI/canvas tasks (3-4) have no automated test coverage, per this project's established pattern — verification is a real headless-browser pass (`playwright-core` pointed at the cached Chromium binary, e.g. `C:/Users/<user>/AppData/Local/ms-playwright/chromium-*/chrome-win/chrome.exe` — locate the exact cached version with a directory listing if the path has changed) driving `npm run mock`, not manual click-throughs claimed without evidence.
- Task 1-2 (backend `fetchKlines`, `seedBars`) ARE automatable — real TDD, no exceptions.
- Files touched: `server/exchanges/{binance,bybit,okx,mock}.js` (modify), `test/server.candles.test.js` (modify), `web/lib/metrics.js` (modify), `test/web.metrics.test.js` (modify), `web/lib/chart.js` (modify), `web/app.js` (modify), `web/index.html` (modify).

---

### Task 1: Backend — `fetchKlines` gains `t`/`o` fields

**Files:**
- Modify: `server/exchanges/binance.js:34-40`
- Modify: `server/exchanges/bybit.js:29-38`
- Modify: `server/exchanges/okx.js:41-48`
- Modify: `server/exchanges/mock.js:39-53`
- Test: `test/server.candles.test.js`

**Interfaces:**
- Produces: every connector's `fetchKlines(sym, interval, limit)` now returns `[{t,o,h,l,c}]` (oldest→newest) instead of `[{h,l,c}]` — `t` is the candle's open timestamp (ms epoch, aligned to the interval boundary), `o` is the open price. Additive change: `server/core/metrics.js`'s `natr`/`avgRange` (already tested, unmodified by this task) only destructure `h`/`l`/`c`, so extra fields don't affect them.

- [ ] **Step 1: Write the failing test**

Append to `test/server.candles.test.js` (add to the existing `import * as mock from "../server/exchanges/mock.js";` file, no new import needed):

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/server.candles.test.js`
Expected: FAIL — `TypeError: Cannot read properties of undefined` (or similar) on `k.t % 300_000`, since `t` is currently `undefined`.

- [ ] **Step 3: Write minimal implementation**

`server/exchanges/binance.js` — change the `fetchKlines` return line:

```js
  return j.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
```

`server/exchanges/bybit.js` — change the `fetchKlines` return line:

```js
  return list.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
```

`server/exchanges/okx.js` — change the `fetchKlines` return line:

```js
  return list.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
```

`server/exchanges/mock.js` — replace the whole `fetchKlines` function (mock has no real exchange timestamps, so it synthesizes interval-aligned ones counting back from now):

```js
const INTERVAL_MS = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

export async function fetchKlines(sym, interval, limit) {
  const s = state.get(sym.replace("USDT", ""));
  const px = s ? s.px : 100;
  const volPct = interval === "1m" ? 0.004 : 0.009;
  const stepMs = INTERVAL_MS[interval] || 300_000;
  const now = Date.now();
  const out = [];
  let c = px;
  for (let i = 0; i < limit; i++) {
    const o = c;
    c = o * (1 + (Math.random() - 0.5) * volPct);
    const h = Math.max(o, c) * (1 + Math.random() * volPct * 0.6);
    const l = Math.min(o, c) * (1 - Math.random() * volPct * 0.6);
    const t = Math.floor((now - (limit - i) * stepMs) / stepMs) * stepMs;
    out.push({ t, o, h, l, c });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/server.candles.test.js`
Expected: `candle api tests passed ✔`

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: all suites pass, including `test/metrics.test.js` (confirms `natr`/`avgRange` are unaffected by the extra fields — those tests construct their own candle fixtures directly, not via `fetchKlines`, but this confirms no regression elsewhere).

```bash
git add server/exchanges/binance.js server/exchanges/bybit.js server/exchanges/okx.js server/exchanges/mock.js test/server.candles.test.js
git commit -m "feat: add t/o (open time/price) fields to fetchKlines across all connectors"
```

---

### Task 2: `web/lib/metrics.js` — `seedBars` on `createBarAggregator`

**Files:**
- Modify: `web/lib/metrics.js`
- Modify: `test/web.metrics.test.js`

**Interfaces:**
- Produces: `createBarAggregator`'s returned object gains `seedBars(symbol, historicalBars)`. `historicalBars` is `[{t,o,h,l,c,v?}]` (the shape Task 1's `fetchKlines` now produces; `v` is optional, defaults to 0 since `/api/candles`'s underlying connectors don't return volume). Replaces that symbol's bar array outright with the seeded history, capped to the same `maxBars` the aggregator was constructed with (keeping the most recent `maxBars` entries via `.slice(-maxBars)`). A subsequent `addTick` whose computed bucket matches the last seeded bar's `t` extends that bar in place (via the existing, unmodified bucket-matching logic in `addTick`); a tick in a new bucket opens a new bar whose `o` is the last bar's `c`, exactly as it already does for purely tick-built bars.

- [ ] **Step 1: Write the failing test**

Append to `test/web.metrics.test.js` (add `seedBars` is not a separate import — it's returned by `createBarAggregator`, already imported):

```js
// --- seedBars: populate with historical bars, cap at maxBars, live ticks extend seamlessly ---
{
  const agg = createBarAggregator(60_000, 3);
  const historical = [
    { t: 0, o: 100, h: 105, l: 98, c: 102, v: 10 },
    { t: 60_000, o: 102, h: 108, l: 101, c: 106, v: 12 },
    { t: 120_000, o: 106, h: 110, l: 104, c: 109, v: 8 }
  ];
  agg.seedBars("BTC", historical);
  let bars = agg.getBars("BTC");
  assert.strictEqual(bars.length, 3);
  assert.deepStrictEqual(bars[2], { t: 120_000, o: 106, h: 110, l: 104, c: 109, v: 8 });

  // seeding respects maxBars cap, keeping the most recent entries
  const longHistory = Array.from({ length: 5 }, (_, i) => ({ t: i * 60_000, o: 100 + i, h: 105 + i, l: 98 + i, c: 102 + i, v: 1 }));
  agg.seedBars("ETH", longHistory);
  assert.strictEqual(agg.getBars("ETH").length, 3, "seeding caps at maxBars");
  assert.strictEqual(agg.getBars("ETH")[0].t, 120_000, "oldest bars beyond the cap are dropped");

  // a live tick whose bucket matches the last seeded bar extends it, not duplicates it
  agg.addTick("BTC", 125_000, 112, 3); // bucket = floor(125000/60000)*60000 = 120000, matches last seeded bar
  bars = agg.getBars("BTC");
  assert.strictEqual(bars.length, 3, "extending the last seeded bar doesn't add a new one");
  assert.strictEqual(bars[2].o, 106, "seeded bar's open price is preserved");
  assert.strictEqual(bars[2].h, 112, "high extends to the new tick's price");
  assert.strictEqual(bars[2].c, 112);
  assert.strictEqual(bars[2].v, 11, "volume accumulates onto the seeded bar (8 + 3)");

  // a live tick in a NEW bucket opens a new bar whose open = the previous bar's close, cap still enforced
  agg.addTick("BTC", 185_000, 115);
  bars = agg.getBars("BTC");
  assert.strictEqual(bars.length, 3, "still capped at maxBars after a new bucket pushes+shifts");
  assert.strictEqual(bars[0].t, 60_000, "oldest seeded bar (t=0) was shifted out");
  assert.strictEqual(bars[2].t, 180_000);
  assert.strictEqual(bars[2].o, 112, "new bar opens at the previous (seeded+extended) bar's close");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/web.metrics.test.js`
Expected: FAIL — `agg.seedBars is not a function`

- [ ] **Step 3: Write minimal implementation**

In `web/lib/metrics.js`, inside `createBarAggregator` (after the existing `reset` function, before the `return` statement):

```js
  function seedBars(symbol, historicalBars) {
    const bars = historicalBars.slice(-maxBars).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 }));
    state.set(symbol, { bars });
  }
```

Update the return statement:

```js
  return { addTick, getBars, reset, seedBars };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/web.metrics.test.js`
Expected: `web metrics (bar aggregation) tests passed ✔`

- [ ] **Step 5: Commit**

```bash
git add web/lib/metrics.js test/web.metrics.test.js
git commit -m "feat: add seedBars to createBarAggregator for real historical candle seeding"
```

---

### Task 3: `web/lib/chart.js` — wall price-level overlay

**Files:**
- Modify: `web/lib/chart.js`

**Interfaces:**
- Consumes: nothing new from other modules — pure canvas drawing addition.
- Produces: `drawPanel(canvas, { bars, price, symbol, trendLines, walls })` — `walls` is a new optional param, shape `{ bid: {price, usd, ex} | null, ask: {price, usd, ex} | null }`. Each present wall draws as a horizontal dashed line (distinct from the existing solid white current-price line) plus a small labeled box at the line's right edge showing `EX_TAG SIZE PRICE`.
- No automated test (canvas rendering, per this project's established non-goal) — verified in Task 5's real-browser pass.

- [ ] **Step 1: Add the wall-drawing logic**

In `web/lib/chart.js`, update the `drawPanel` export's destructured parameter list and add wall drawing after the existing current-price-line block (find the `if (price != null) { ... }` block that draws the dashed current-price line):

```js
export function drawPanel(canvas, { bars, price, symbol, trendLines, walls }) {
```

After the existing `if (price != null) { ... ctx.setLineDash([]); }` block (which draws the current-price line), add:

```js
  if (walls?.bid) drawWallLine(ctx, walls.bid, "bid", w, y, yMin, yMax);
  if (walls?.ask) drawWallLine(ctx, walls.ask, "ask", w, y, yMin, yMax);
```

Add the new helper function (alongside the existing `drawTrendLine` helper):

```js
function drawWallLine(ctx, wall, side, w, y, yMin, yMax) {
  if (wall.price < yMin || wall.price > yMax) return;
  const yy = y(wall.price);
  const color = side === "bid" ? UP : DOWN;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(0, yy);
  ctx.lineTo(w, yy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  const label = `${wall.ex} ${fmtWallSize(wall.usd)} ${wall.price}`;
  ctx.font = "9px monospace";
  const textW = ctx.measureText(label).width;
  const boxW = textW + 8, boxH = 14;
  const boxX = w - boxW - 2, boxY = yy - boxH / 2;
  ctx.fillStyle = side === "bid" ? "rgba(65,217,157,.18)" : "rgba(255,93,115,.18)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.6;
  ctx.strokeRect(boxX, boxY, boxW, boxH);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, boxX + 4, yy);
  ctx.restore();
}

function fmtWallSize(usd) {
  if (usd >= 1e6) return (usd / 1e6).toFixed(usd >= 1e7 ? 0 : 1) + "M";
  if (usd >= 1e3) return Math.round(usd / 1e3) + "K";
  return String(Math.round(usd));
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check web/lib/chart.js`
Expected: exits 0, no output.

- [ ] **Step 3: Commit**

```bash
git add web/lib/chart.js
git commit -m "feat: add wall price-level overlay to chart panel renderer"
```

---

### Task 4: `web/app.js` + `web/index.html` — wire history fetch, wall data, expanded timeframe

**Files:**
- Modify: `web/app.js`
- Modify: `web/index.html`

**Interfaces:**
- Consumes: `agg.seedBars` (Task 2), `drawPanel`'s new `walls` param (Task 3), `/api/candles` (existing, from the foundation plan).
- Produces: panels fetch real history on becoming visible or on timeframe change; each panel's top bid/ask wall is computed and passed into `drawPanelFor`; `#timeframeSel` offers the full interval set.
- No automated test (DOM/fetch wiring) — verified in Task 5's real-browser pass.

- [ ] **Step 1: Expand the timeframe selector options**

In `web/index.html`, find `#timeframeSel` (added in Task 7 of the prior UI plan) and replace its `<option>` list:

```html
    <select id="timeframeSel">
      <option value="1m">1m</option>
      <option value="5m" selected>5m</option>
      <option value="15m">15m</option>
      <option value="30m">30m</option>
      <option value="1h">1h</option>
      <option value="4h">4h</option>
      <option value="1d">1d</option>
    </select>
```

- [ ] **Step 2: Update `TIMEFRAMES` and the default `timeframe` in `web/app.js`**

Find the existing `TIMEFRAMES` map and `let timeframe = "5M";` line (note: prior plan used uppercase `"5M"`/`"1M"`/`"15M"` labels — this task switches to lowercase to match the exchange's own interval string convention, since these values now get passed directly to `/api/candles`, not just used as internal labels). Replace:

```js
const TIMEFRAMES = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
let timeframe = "5m";
```

This is the same `INTERVAL_MS` mapping as Task 1's mock connector — intentionally duplicated (client and server are separate runtimes with no shared module today; introducing one for a single small constant map would be over-engineering for this scope).

- [ ] **Step 3: Add the history-fetch function and wire it into panel creation + timeframe change**

Add near the other fetch-based helpers (alongside `fetchCustomMetric` from Task 6 of the prior plan):

```js
async function seedHistory(sym) {
  try {
    const r = await fetch(`/api/candles?symbol=${sym}&interval=${timeframe}&limit=200`);
    if (!r.ok) return;
    const candles = await r.json();
    if (candles.length) aggregator.seedBars(sym, candles);
  } catch { /* live ticks will still build the chart from here */ }
}
```

In `makePanel(sym)` (the function that creates a new panel's DOM, from Task 3 of the prior plan, already modified by Tasks 5-6), call `seedHistory(sym)` once when the panel is first created — find the end of `makePanel`, right before its `return { el, canvas: el.querySelector("canvas") };` line, and add:

```js
  seedHistory(sym);
```

Find the timeframe `<select>`'s change handler (from Task 7 of the prior plan):

```js
$("timeframeSel").addEventListener("change", e => {
  timeframe = e.target.value;
  aggregator = createBarAggregator(TIMEFRAMES[timeframe]);
  trendLinesBySym.clear();
  lastBarTsBySym.clear();
  renderBoardGrid();
});
```

Change it to also re-seed every currently-visible panel at the new interval:

```js
$("timeframeSel").addEventListener("change", e => {
  timeframe = e.target.value;
  aggregator = createBarAggregator(TIMEFRAMES[timeframe]);
  trendLinesBySym.clear();
  lastBarTsBySym.clear();
  for (const sym of panelEls.keys()) seedHistory(sym);
  renderBoardGrid();
});
```

- [ ] **Step 4: Compute and pass per-panel wall data into the renderer**

In `renderBoardGrid()`'s per-coin loop (already modified across Tasks 3, 5, 6 of the prior plan), find the call to `drawPanelFor(c.s, c.l)` and the `drawPanelFor` function itself. Add a helper to pick the top bid/ask wall for a symbol:

```js
function topWallsFor(sym) {
  const symWalls = walls.filter(w => w.sym === sym);
  const bid = symWalls.filter(w => w.side === "bid").sort((a, b) => b.usd - a.usd)[0] || null;
  const ask = symWalls.filter(w => w.side === "ask").sort((a, b) => b.usd - a.usd)[0] || null;
  return { bid, ask };
}
```

Update `drawPanelFor` to compute and pass walls:

```js
function drawPanelFor(sym, price) {
  const p = panelEls.get(sym);
  if (!p) return;
  const rect = p.canvas.getBoundingClientRect();
  const w = Math.round(rect.width), h = Math.round(rect.height);
  if (w > 0 && (p.canvas.width !== w || p.canvas.height !== h)) { p.canvas.width = w; p.canvas.height = h; }
  drawPanel(p.canvas, { bars: aggregator.getBars(sym), price, symbol: sym, trendLines: trendLinesBySym.get(sym), walls: topWallsFor(sym) });
}
```

- [ ] **Step 5: Verify syntax**

Run: `node --check web/app.js`
Expected: exits 0, no output.

- [ ] **Step 6: Commit**

```bash
git add web/app.js web/index.html
git commit -m "feat: fetch real history on panel-visible/timeframe-change, wire wall overlay, expand timeframe options"
```

---

### Task 5: Real-browser verification pass

- [ ] **Step 1: Start the mock server**

```bash
npm run mock
```
(background it, e.g. `npm run mock > /tmp/server.log 2>&1 &`; on Windows stop it afterward with `taskkill //F //IM node.exe`)

- [ ] **Step 2: Drive a real headless browser through the new functionality**

Using `playwright-core` against the machine's cached Chromium binary (the same approach used throughout the prior UI plan — locate the cached version under `AppData/Local/ms-playwright/chromium-*/chrome-win/chrome.exe` if the exact path differs), write and run a script from a scratch directory (not the project) that:

1. Navigates to `http://localhost:8080/`, waits for the Board grid to populate.
2. For the first panel, captures the canvas's `toDataURL()` immediately — assert it's non-trivial length (real content drawn), not just a blank/single-candle canvas, confirming real history rendered rather than the old single-accumulating-candle behavior.
3. Checks the Network tab / requests for a `GET /api/candles?symbol=...` firing shortly after page load for each visible panel (confirms the fetch-on-visible wiring from Task 4 actually runs).
4. Changes `#timeframeSel` to `"1h"`, waits briefly, confirms new `/api/candles?...interval=1h...` requests fire for the visible panels (confirms fetch-on-timeframe-change).
5. If any wall data is present in this mock session (mock plants walls periodically — may need a short wait), screenshots a panel and visually confirms a wall line/label box renders (or logs that no wall was present in this particular session if mock didn't plant one on a tracked symbol within the wait window — not a failure, just note it and don't claim visual confirmation you didn't actually get).
6. Checks console/page errors are empty throughout.

Report the exact script output (values, not just "it worked") before claiming this task complete.

- [ ] **Step 3: Run the full automated suite as a regression check**

Run: `npm test`
Expected: all suites pass (this task's own changes plus Tasks 1-2's new tests, all 9+ suites).

- [ ] **Step 4: Confirm no stray files**

Run: `git status`
Expected: working tree clean.

## What This Completes

Chart panels now show real historical candles immediately, extend live exactly as before, overlay the top bid/ask order-book wall with labeled price lines, and offer the full exchange-aligned timeframe range (1m/5m/15m/30m/1h/4h/1d) — closing the gap identified against the reference screenshot.
