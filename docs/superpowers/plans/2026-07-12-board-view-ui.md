# Board View: UI Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Board tab — a live multi-chart grid replacing the Screener as the default view, with a collapsible left sidebar (Coin List / Density Map / Listings), color tagging, arbitrary-period NATR/Range, and all top-bar controls — wired on top of the tested foundation from `docs/superpowers/plans/2026-07-12-board-view-foundation.md`.

**Architecture:** Split `web/index.html`'s inline script into `web/app.js` (state, WebSocket handling, DOM wiring) and `web/lib/chart.js` (pure canvas draw routine), importing `web/lib/metrics.js`'s already-tested `createBarAggregator`/`selectCoins`/`paginate`/`pageCount`/`findTrendLines`/`natr`/`avgRange` as fixed contracts. No build step — native ES modules via `<script type="module">`.

**Tech Stack:** Plain HTML/CSS/vanilla ES modules, Canvas 2D. Zero new dependencies.

## Global Constraints

- Node >=20, ESM only — no CommonJS `require`, everything in `web/` uses `<script type="module">` / `import`/`export`.
- No new dependencies, no build step, no bundler.
- Match existing code style: no comments except where genuinely non-obvious.
- **This plan is UI/DOM/canvas work with no automated test coverage** — per `docs/superpowers/specs/2026-07-12-board-view-design.md` section 9 ("Canvas rendering and visual layout are not automated... verification is manual"). Every task's verification step is: run `npm run mock`, open `http://localhost:8080` in a browser, and perform the exact actions listed. This is a deliberate, spec-sanctioned deviation from TDD's automated RED/GREEN cycle — do not flag "no test" as a defect for this plan.
- Reuse existing helpers/conventions from `web/index.html`'s current inline script exactly (`$`, `EX_TAG`, `fmtPx`, `fmtBig`, `fmtTime`, the `rowCache`-style DOM-diffing pattern) rather than reinventing them.
- CSS custom properties already defined in `web/index.html`'s `:root` (`--bg`, `--panel`, `--panel-2`, `--line`, `--text`, `--muted`, `--up`, `--down`, `--amber`, `--accent`) are the palette — new UI reuses them, `web/lib/chart.js`'s canvas drawing uses their literal hex equivalents (`--up` = `#41d99d`, `--down` = `#ff5d73`) since CSS custom properties aren't directly readable inside canvas draw calls without an extra `getComputedStyle` round-trip.
- Files touched: `web/index.html` (modify), `web/app.js` (new, replacing the inline script), `web/lib/chart.js` (new).

---

### Task 1: Extract inline script into `web/app.js` (pure refactor, zero functional change)

**Files:**
- Modify: `web/index.html`
- Create: `web/app.js`

**Interfaces:**
- Produces: `web/app.js` — an ES module containing the exact same code currently inline in `web/index.html`'s `<script>` tag (lines 189-432), unchanged. No new imports yet — this task is refactor-only, verified to be behavior-identical before any new feature work lands on top of it.

- [ ] **Step 1: Extract the script**

Cut everything between (and not including) the `<script>` and `</script>` tags at the end of `web/index.html` (currently lines 190-431, i.e. everything after `"use strict";` through the final `renderScreener();` call inside the `headRow` click handler) into a new file `web/app.js`, with `"use strict";` removed (ES modules are strict by default, redundant `"use strict"` is a lint nit but harmless — remove it for cleanliness).

Replace the `<script>...</script>` block in `web/index.html` with:

```html
<script type="module" src="app.js"></script>
```

- [ ] **Step 2: Manual verification — existing functionality unchanged**

Run: `npm run mock`
Open: `http://localhost:8080`

Verify, exactly as before this refactor:
- Screener tab (still the active/default tab at this point — Task 2 changes the default) shows a live-updating coin table.
- Clicking Density and Alerts tabs switches views correctly.
- Search box filters rows; min-volume dropdown filters; watchlist star toggles and persists on reload; sort by clicking column headers works; setting a price alert via the ⏰ icon works and appears in the Alerts tab.
- Open the browser console — no errors.

- [ ] **Step 3: Commit**

```bash
git add web/index.html web/app.js
git commit -m "refactor: extract inline script into web/app.js ES module"
```

---

### Task 2: Board tab layout scaffold (collapsible left panel + chart grid container)

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`

**Interfaces:**
- Produces: a new `#view-board` view (the new default/active view), containing `#boardSidebar` (collapsible, with `#sideToggle` button and three empty panel containers `#coinListBody`/`#densityMapBody`/`#listingsBody`, populated in Task 4) and `#boardGridWrap` > `#boardGrid` (empty grid container, populated in Task 3).
- Consumes: nothing new yet from `web/lib/metrics.js` — pure layout/CSS/toggle wiring.

- [ ] **Step 1: Add the Board nav tab and view markup**

In `web/index.html`, change the `<nav>` block (currently):

```html
  <nav>
    <button data-view="screener" class="on">Screener</button>
    <button data-view="density">Density</button>
    <button data-view="alerts">Alerts</button>
  </nav>
```

to:

```html
  <nav>
    <button data-view="board" class="on">Board</button>
    <button data-view="screener">Screener</button>
    <button data-view="density">Density</button>
    <button data-view="alerts">Alerts</button>
  </nav>
```

Change the screener view's opening tag from `<div class="view on" id="view-screener">` to `<div class="view" id="view-screener">` (Board is now the default-visible view, not Screener).

Add a new view, right after the opening `<main>` tag and before the `<!-- SCREENER -->` comment:

```html
  <!-- BOARD -->
  <div class="view on" id="view-board">
    <div class="boardWrap">
      <aside class="boardSidebar" id="boardSidebar">
        <button class="sideToggle" id="sideToggle" title="Collapse panel">‹</button>
        <div class="sidePanel" id="panelCoinList">
          <h3>Coin list</h3>
          <div class="sideBody" id="coinListBody"></div>
        </div>
        <div class="sidePanel" id="panelDensityMap">
          <h3>Density Map</h3>
          <div class="sideBody" id="densityMapBody"></div>
        </div>
        <div class="sidePanel" id="panelListings">
          <h3>Listings</h3>
          <div class="sideBody" id="listingsBody"></div>
        </div>
      </aside>
      <div class="boardGridWrap">
        <div class="boardGrid" id="boardGrid"></div>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Add CSS**

Append to the `<style>` block in `web/index.html`, right before the closing `</style>`:

```css
  /* ---- board ---- */
  .boardWrap{display:flex;height:100%}
  .boardSidebar{width:280px;flex:none;overflow-y:auto;border-right:1px solid var(--line);background:var(--panel);transition:width .2s,opacity .2s}
  .boardSidebar.collapsed{width:0;opacity:0;overflow:hidden;border-right:none}
  .sideToggle{position:sticky;top:0;z-index:1;width:100%;background:var(--panel-2);border:none;border-bottom:1px solid var(--line);color:var(--muted);cursor:pointer;padding:6px;font-size:13px;font-family:var(--font-mono)}
  .sideToggle:hover{color:var(--text)}
  .sidePanel{border-bottom:1px solid var(--line)}
  .sidePanel h3{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:500;padding:10px 12px 6px}
  .sideBody{padding:0 4px 8px;font-size:11px}
  .boardGridWrap{flex:1;overflow-y:auto}
  .boardGrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:8px}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;min-height:180px}
  .panelHead{display:flex;align-items:center;gap:6px;padding:6px 8px;font-size:11px;border-bottom:1px solid var(--line)}
  .panelHead .sym{font-weight:700}
  .panelHead .tag{font-size:9px;color:var(--muted)}
  .panelHead .spacer{flex:1}
  .freshDot{width:6px;height:6px;border-radius:50%;background:var(--up);flex:none}
  .freshDot.stale{background:var(--down)}
  .panel canvas{width:100%;flex:1;display:block;min-height:120px}
```

- [ ] **Step 3: Wire the sidebar toggle**

Append to `web/app.js`:

```js
$("sideToggle").onclick = () => {
  $("boardSidebar").classList.toggle("collapsed");
  $("sideToggle").textContent = $("boardSidebar").classList.contains("collapsed") ? "›" : "‹";
};
```

- [ ] **Step 4: Manual verification**

Run: `npm run mock`, open `http://localhost:8080`.

Verify:
- Board tab is active by default on page load (empty grid/sidebar shells, since Task 3/4 populate them).
- Clicking Screener/Density/Alerts still works exactly as before (Task 1 didn't regress).
- Clicking the `‹` toggle button collapses the left sidebar (grid area expands to fill the space); clicking again (now `›`) expands it back.
- No console errors.

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/app.js
git commit -m "feat: add Board tab layout scaffold (collapsible sidebar + grid container)"
```

---

### Task 3: Chart panel canvas renderer + live grid wiring

**Files:**
- Create: `web/lib/chart.js`
- Modify: `web/app.js`

**Interfaces:**
- Produces: `drawPanel(canvas, { bars, price, symbol, trendLines })` in `web/lib/chart.js` — clears and redraws the canvas: ticker watermark, candle bodies/wicks, a volume histogram strip, a dashed current-price line, and support/resistance trend lines if present in `trendLines` (the `{resistance, support}` shape `findTrendLines` returns).
- Consumes: `createBarAggregator`, `selectCoins`, `paginate`, `pageCount`, `findTrendLines` from `web/lib/metrics.js` (all built and tested in the foundation plan).
- Establishes app-level state in `web/app.js`: a single background `aggregator` (5-minute bars by default) fed from every incoming `snap` message for **all** tracked coins (not just the current grid page), a `gridDensity` (default 9) and `gridPage` (default 0) pair, and a `panelEls` map (`symbol -> {el, canvas}`) of currently-rendered grid DOM nodes.

- [ ] **Step 1: Write the canvas renderer**

Create `web/lib/chart.js`:

```js
const UP = "#41d99d", DOWN = "#ff5d73";

export function drawPanel(canvas, { bars, price, symbol, trendLines }) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!bars || !bars.length || !w || !h) return;

  const volH = Math.round(h * 0.18);
  const chartH = h - volH;
  const highs = bars.map(b => b.h), lows = bars.map(b => b.l);
  const lo = Math.min(...lows, price ?? Infinity);
  const hi = Math.max(...highs, price ?? -Infinity);
  const pad = (hi - lo) * 0.08 || 1;
  const yMin = lo - pad, yMax = hi + pad;
  const y = v => chartH - ((v - yMin) / (yMax - yMin)) * chartH;

  const n = bars.length;
  const slot = w / n;
  const bw = Math.max(1, slot * 0.6);

  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.round(h * 0.28)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(symbol, w / 2, chartH / 2);
  ctx.restore();

  bars.forEach((b, i) => {
    const cx = i * slot + slot / 2;
    const up = b.c >= b.o;
    ctx.strokeStyle = ctx.fillStyle = up ? UP : DOWN;
    ctx.beginPath();
    ctx.moveTo(cx, y(b.h));
    ctx.lineTo(cx, y(b.l));
    ctx.stroke();
    const top = y(Math.max(b.o, b.c)), bot = y(Math.min(b.o, b.c));
    ctx.fillRect(cx - bw / 2, top, bw, Math.max(1, bot - top));
  });

  const maxV = Math.max(...bars.map(b => b.v), 1);
  bars.forEach((b, i) => {
    const cx = i * slot + slot / 2;
    const vh = (b.v / maxV) * volH;
    ctx.fillStyle = b.c >= b.o ? "rgba(65,217,157,.4)" : "rgba(255,93,115,.4)";
    ctx.fillRect(cx - bw / 2, h - vh, bw, vh);
  });

  if (price != null) {
    ctx.strokeStyle = "#ffffff";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y(price));
    ctx.lineTo(w, y(price));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (trendLines?.resistance) drawTrendLine(ctx, trendLines.resistance, n, slot, y, DOWN);
  if (trendLines?.support) drawTrendLine(ctx, trendLines.support, n, slot, y, UP);
}

function drawTrendLine(ctx, line, n, slot, y, color) {
  const x1 = line.p1.i * slot + slot / 2, x2 = (n - 1) * slot + slot / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(x1, y(line.valueAt(line.p1.i)));
  ctx.lineTo(x2, y(line.valueAt(n - 1)));
  ctx.stroke();
  ctx.restore();
}
```

- [ ] **Step 2: Wire the background aggregator and grid rendering into `web/app.js`**

Add near the top of `web/app.js` (alongside the existing `let coins = [];` etc. state declarations):

```js
import { createBarAggregator, selectCoins, paginate, pageCount, findTrendLines } from "./lib/metrics.js";
import { drawPanel } from "./lib/chart.js";

const TIMEFRAMES = { "1M": 60_000, "5M": 300_000, "15M": 900_000 };
let timeframe = "5M";
let aggregator = createBarAggregator(TIMEFRAMES[timeframe]);
const trendLinesBySym = new Map();   // symbol -> {resistance, support}
const barCountBySym = new Map();     // symbol -> last-seen bar count (to know when a bar closed)
const lastTickAt = new Map();        // symbol -> ts, for the freshness dot
let gridDensity = 9;                 // 3 / 6 / 9, Task 7 adds the selector
let gridPage = 0;
const panelEls = new Map();          // symbol -> {el, canvas}
```

Add the grid-rendering functions (anywhere after the `visible()`/`renderScreener()` functions is fine):

```js
function boardOpts() {
  return { minVol, searchQ, sortKey, sortDir, tagFilter: "all", tags: new Map() }; // Task 5 wires real tags
}

function feedAggregator(list, ts) {
  for (const c of list) {
    aggregator.addTick(c.s, ts, c.l, 0);
    lastTickAt.set(c.s, ts);
    const bars = aggregator.getBars(c.s);
    const prevCount = barCountBySym.get(c.s) ?? 0;
    if (bars.length !== prevCount) {
      barCountBySym.set(c.s, bars.length);
      trendLinesBySym.set(c.s, findTrendLines(bars));
    }
  }
}

function makePanel(sym) {
  const el = document.createElement("div");
  el.className = "panel";
  el.innerHTML =
    `<div class="panelHead"><span class="freshDot"></span><span class="sym"></span>` +
    `<span class="tag"></span><span class="spacer"></span><span class="chg"></span></div>` +
    `<canvas></canvas>`;
  return { el, canvas: el.querySelector("canvas") };
}

function drawPanelFor(sym, price) {
  const p = panelEls.get(sym);
  if (!p) return;
  const rect = p.canvas.getBoundingClientRect();
  const w = Math.round(rect.width), h = Math.round(rect.height);
  if (w > 0 && (p.canvas.width !== w || p.canvas.height !== h)) { p.canvas.width = w; p.canvas.height = h; }
  drawPanel(p.canvas, { bars: aggregator.getBars(sym), price, symbol: sym, trendLines: trendLinesBySym.get(sym) });
}

function renderBoardGrid() {
  const list = selectCoins(coins, boardOpts());
  const pages = pageCount(list.length, gridDensity);
  gridPage = Math.min(gridPage, pages - 1);
  const pageList = paginate(list, gridPage, gridDensity);
  const grid = $("boardGrid");

  const seen = new Set();
  for (const c of pageList) {
    seen.add(c.s);
    let p = panelEls.get(c.s);
    if (!p) { p = makePanel(c.s); panelEls.set(c.s, p); }
    grid.appendChild(p.el);
    p.el.querySelector(".sym").textContent = c.s;
    p.el.querySelector(".tag").textContent = EX_TAG[c.x] || c.x;
    const chgEl = p.el.querySelector(".chg");
    chgEl.textContent = (c.c > 0 ? "+" : "") + c.c.toFixed(1) + "%";
    chgEl.className = "chg " + (c.c >= 0 ? "up" : "down");
    const stale = (Date.now() - (lastTickAt.get(c.s) ?? 0)) > 5000;
    p.el.querySelector(".freshDot").classList.toggle("stale", stale);
    drawPanelFor(c.s, c.l);
  }
  for (const [sym, p] of panelEls) {
    if (!seen.has(sym)) { p.el.remove(); panelEls.delete(sym); }
  }
}
```

Hook both into the existing WebSocket `snap` handler. Find this block in `web/app.js` (from the original inline script):

```js
    if(m.t === "snap"){
      coins = m.coins; renderStatus(m.status);
      $("klAge").textContent = m.klineTs ? Math.round((Date.now()-m.klineTs)/1000)+"s ago" : "loading…";
      renderScreener();
    }
```

Change it to:

```js
    if(m.t === "snap"){
      coins = m.coins; renderStatus(m.status);
      $("klAge").textContent = m.klineTs ? Math.round((Date.now()-m.klineTs)/1000)+"s ago" : "loading…";
      renderScreener();
      feedAggregator(coins, Date.now());
      renderBoardGrid();
    }
```

- [ ] **Step 3: Manual verification**

Run: `npm run mock`, open `http://localhost:8080`.

Verify:
- Board tab (default) shows a 3-column grid of up to 9 panels, each with a symbol, exchange tag, % change, and a canvas.
- Within a few seconds of ticks arriving, each canvas starts drawing a candlestick chart that visibly updates (mock mode ticks every ~900ms per `server/exchanges/mock.js`).
- Wait long enough for at least one 5-minute bar boundary in mock mode (or temporarily lower `TIMEFRAMES["5M"]` to `10_000` in your browser's devtools to speed up manual testing, then revert) — confirm a second bar appears and, once at least 2 swing points exist, a colored trend line appears on some panel.
- The small dot in each panel's header is green; if you throttle/disconnect network in devtools for >5s, dots for symbols not receiving ticks should turn red-ish (`stale` class) — reconnect and confirm they go green again.
- No console errors, no runaway memory growth over a minute of observation (Chrome DevTools Performance/Memory tab, optional spot check).

- [ ] **Step 4: Commit**

```bash
git add web/lib/chart.js web/app.js
git commit -m "feat: add canvas chart renderer and live grid wiring with trend lines"
```

---

### Task 4: Sidebar panels — Coin List, Density Map, Listings

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`

**Interfaces:**
- Produces: three render functions in `web/app.js` — `renderCoinList()`, `renderDensityMap()`, `renderListings(evt)` — populating the three sidebar containers added in Task 2.

- [ ] **Step 1: Add sidebar CSS**

Append to `web/index.html`'s `<style>` block:

```css
  .clRow{display:flex;justify-content:space-between;gap:6px;padding:4px 8px;font-size:11px;border-bottom:1px solid #0f1d21}
  .clRow .s{font-weight:700}
  .densityCols{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;padding:0 8px}
  .densityCols h4{font-size:9px;text-transform:uppercase;color:var(--muted);text-align:center;padding:4px 0;grid-column:span 1}
  .wallBadge{font-size:9px;padding:2px 5px;border-radius:4px;margin:2px 0;display:block;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .wallBadge.bid{background:rgba(65,217,157,.15);color:var(--up)}
  .wallBadge.ask{background:rgba(255,93,115,.15);color:var(--down)}
  .listRow{display:flex;justify-content:space-between;gap:6px;padding:4px 8px;font-size:11px;border-bottom:1px solid #0f1d21}
```

- [ ] **Step 2: Implement the three render functions in `web/app.js`**

```js
function renderCoinList() {
  const list = selectCoins(coins, boardOpts()).slice(0, 100);
  $("coinListBody").innerHTML = list.map(c =>
    `<div class="clRow"><span class="s">${c.s}</span><span class="${c.c>=0?'up':'down'}">${(c.c>0?'+':'')+c.c.toFixed(1)}%</span><span class="dim">${fmtBig(c.v)}</span></div>`
  ).join("") || `<div class="clRow dim">No coins match the current filters</div>`;
}

function renderDensityMap() {
  const large = walls.filter(w => w.usd >= 1_000_000);
  const medium = walls.filter(w => w.usd >= 300_000 && w.usd < 1_000_000);
  const small = walls.filter(w => w.usd < 300_000);
  const col = list => list.slice(0, 20).map(w =>
    `<span class="wallBadge ${w.side}">${EX_TAG[w.ex]||w.ex} ${w.sym} ${fmtBig(w.usd)}</span>`
  ).join("") || `<span class="dim" style="font-size:10px">none</span>`;
  $("densityMapBody").innerHTML =
    `<div class="densityCols"><h4>Large</h4><h4>Medium</h4><h4>Small</h4>` +
    `<div>${col(large)}</div><div>${col(medium)}</div><div>${col(small)}</div></div>`;
}

const listingEvents = [];
function renderListings(evt) {
  if (evt) { listingEvents.unshift(evt); if (listingEvents.length > 30) listingEvents.pop(); }
  $("listingsBody").innerHTML = listingEvents.map(e =>
    `<div class="listRow"><span class="s">${e.sym}</span><span class="dim">${fmtTime(e.ts)}</span></div>`
  ).join("") || `<div class="listRow dim">No new listings yet</div>`;
}
```

- [ ] **Step 3: Wire these into the existing WebSocket handlers**

In the `snap` handler (already modified in Task 3), add `renderCoinList();` after `renderBoardGrid();`.

Find the existing `density` message handler:
```js
    } else if(m.t === "density"){
      walls = m.walls || []; renderDensity();
```
Change to:
```js
    } else if(m.t === "density"){
      walls = m.walls || []; renderDensity(); renderDensityMap();
```

Find the existing `hello` message handler (initial connection):
```js
    } else if(m.t === "hello"){
      armedAlerts = m.alerts || []; walls = m.walls || []; renderStatus(m.status);
      renderArmed(); renderDensity();
      for(const a of (m.recent||[]).slice(-15)) feedItem(a, false);
```
Change to also seed the density map and route past "listing" events into the Listings panel:
```js
    } else if(m.t === "hello"){
      armedAlerts = m.alerts || []; walls = m.walls || []; renderStatus(m.status);
      renderArmed(); renderDensity(); renderDensityMap();
      for(const a of (m.recent||[]).slice(-15)){
        feedItem(a, false);
        if(a.kind === "listing") renderListings(a);
      }
```

Find the existing `alert` message handler (live events):
```js
    } else if(m.t === "alert"){
      feedItem(m, true);
```
Change to:
```js
    } else if(m.t === "alert"){
      feedItem(m, true);
      if(m.kind === "listing") renderListings(m);
```

- [ ] **Step 4: Manual verification**

Run: `npm run mock`, open `http://localhost:8080`.

Verify:
- Coin List panel in the sidebar shows a live-updating compact list matching the same coins/order as the main grid's current filter/sort.
- Density Map panel shows Large/Medium/Small columns with colored badges once wall data arrives (mock mode plants walls periodically per `server/exchanges/mock.js`).
- Wait for (or trigger, if testable in mock mode) a new-listing event — confirm it appears in the Listings panel with a ticker and timestamp.
- No console errors.

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/app.js
git commit -m "feat: add Coin List, Density Map, and Listings sidebar panels"
```

---

### Task 5: Color-tag UI

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`

**Interfaces:**
- Produces: a `tagMap` (`Map<symbol,color>`, persisted to `localStorage` key `tb.tags`), a top-bar "ALL" + color-pill filter row, and a small color-picker popover triggered from each panel's header.
- Consumes: `selectCoins`'s `tagFilter`/`tags` options (already built in the foundation plan) — `boardOpts()` (from Task 3) gets wired to pass the real `tagMap` and current filter instead of its Task-3 placeholder `{tagFilter:"all", tags:new Map()}`.

- [ ] **Step 1: Add the tag-pill row and popover markup/CSS**

In `web/index.html`, inside `<header>`, right after the `<nav>...</nav>` block and before `<div class="spacer"></div>`, add:

```html
  <div class="tagPills" id="tagPills">
    <button class="tagPill on" data-tag="all">ALL</button>
    <button class="tagPill" data-tag="red" style="--tc:var(--down)"></button>
    <button class="tagPill" data-tag="green" style="--tc:var(--up)"></button>
    <button class="tagPill" data-tag="purple" style="--tc:#a463f2"></button>
  </div>
```

Append CSS:

```css
  .tagPills{display:flex;gap:4px}
  .tagPill{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);background:var(--tc,var(--panel-2));cursor:pointer;font-size:9px;color:var(--muted);display:flex;align-items:center;justify-content:center}
  .tagPill.on{border-color:var(--text)}
  .tagPopover{position:absolute;background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:6px;display:flex;gap:4px;z-index:20}
  .tagPopover button{width:18px;height:18px;border-radius:50%;border:1px solid var(--line);cursor:pointer}
```

- [ ] **Step 2: Implement the tag model and filter wiring in `web/app.js`**

Replace Task 3's placeholder `boardOpts()` function entirely (don't leave both versions in the file — this is a modification of that function, not a second declaration):

```js
const TAG_COLORS = ["red", "green", "purple"];
const tagMap = new Map(JSON.parse(localStorage.getItem("tb.tags") || "[]"));
if (!tagMap.size) {
  for (const sym of watch) tagMap.set(sym, "green"); // migrate the existing single-star watchlist
}
let tagFilter = "all";

function saveTags() { localStorage.setItem("tb.tags", JSON.stringify([...tagMap])); }

function boardOpts() {
  return { minVol, searchQ, sortKey, sortDir, tagFilter, tags: tagMap };
}
```

Add the pill-click wiring:

```js
$("tagPills").addEventListener("click", e => {
  const btn = e.target.closest(".tagPill");
  if (!btn) return;
  tagFilter = btn.dataset.tag;
  [...$("tagPills").children].forEach(b => b.classList.toggle("on", b === btn));
  renderBoardGrid();
  renderCoinList();
});

function openTagPopover(anchorEl, sym) {
  document.querySelector(".tagPopover")?.remove();
  const pop = document.createElement("div");
  pop.className = "tagPopover";
  const rect = anchorEl.getBoundingClientRect();
  pop.style.left = rect.left + "px";
  pop.style.top = (rect.bottom + 4) + "px";
  pop.innerHTML =
    `<button data-c="" style="background:transparent" title="Clear"></button>` +
    TAG_COLORS.map(c => `<button data-c="${c}" style="background:${
      c === "red" ? "var(--down)" : c === "green" ? "var(--up)" : "#a463f2"
    }"></button>`).join("");
  pop.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.c) tagMap.set(sym, b.dataset.c); else tagMap.delete(sym);
    saveTags();
    pop.remove();
    renderBoardGrid();
    renderCoinList();
  });
  document.body.appendChild(pop);
  setTimeout(() => document.addEventListener("click", function close(e) {
    if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("click", close); }
  }), 0);
}
```

In Task 3's `makePanel(sym)`, add a click handler on the symbol span to open the popover. Change:

```js
function makePanel(sym) {
  const el = document.createElement("div");
  el.className = "panel";
  el.innerHTML =
    `<div class="panelHead"><span class="freshDot"></span><span class="sym"></span>` +
    `<span class="tag"></span><span class="spacer"></span><span class="chg"></span></div>` +
    `<canvas></canvas>`;
  return { el, canvas: el.querySelector("canvas") };
}
```

to:

```js
function makePanel(sym) {
  const el = document.createElement("div");
  el.className = "panel";
  el.innerHTML =
    `<div class="panelHead"><span class="freshDot"></span><span class="sym" style="cursor:pointer"></span>` +
    `<span class="tag"></span><span class="spacer"></span><span class="chg"></span></div>` +
    `<canvas></canvas>`;
  el.querySelector(".sym").onclick = e => openTagPopover(e.target, sym);
  return { el, canvas: el.querySelector("canvas") };
}
```

Also tint each panel's border by its tag color — in `renderBoardGrid()`'s per-coin loop (from Task 3), after `p.el.querySelector(".tag").textContent = ...`, add:

```js
    p.el.style.borderColor = tagMap.has(c.s) ? `var(--${tagMap.get(c.s) === "green" ? "up" : tagMap.get(c.s) === "red" ? "down" : "accent"})` : "";
```

(purple has no matching semantic CSS variable — it falls back to `--accent` for a visible-but-not-red/green tint; acceptable simplification.)

- [ ] **Step 3: Manual verification**

Run: `npm run mock`, open `http://localhost:8080`.

Verify:
- Clicking a panel's ticker symbol opens a small color popover; picking a color tints that panel's border and persists (reload the page — the tag is still applied, confirming `localStorage` round-trip).
- Clicking a color pill in the top bar filters the grid and Coin List to only tagged coins of that color; clicking "ALL" clears the filter.
- If you previously starred a coin in the Screener tab's watchlist (existing feature), confirm it now shows as "green"-tagged in the Board view on first load (migration).
- No console errors.

- [ ] **Step 4: Commit**

```bash
git add web/index.html web/app.js
git commit -m "feat: add multi-color ticker tagging with watchlist migration"
```

---

### Task 6: Arbitrary-period NATR/Range control

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`

**Interfaces:**
- Produces: clicking a panel's change/NATR area opens a small period-picker (interval + count inputs); submitting fetches `GET /api/candles?symbol=...&interval=...&limit=...` (the endpoint built in the foundation plan) and computes `natr`/`avgRange` client-side (also from the foundation plan) to display a custom-period value for that panel only.

- [ ] **Step 1: Add the popover markup/CSS**

Append CSS to `web/index.html`:

```css
  .periodPopover{position:absolute;background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:8px;display:flex;gap:6px;align-items:center;z-index:20;font-size:11px}
  .periodPopover input,.periodPopover select{width:60px;padding:4px 6px;font-size:11px}
  .customPeriod{font-size:9px;color:var(--accent);cursor:pointer;text-decoration:underline dotted}
```

- [ ] **Step 2: Implement the period picker and per-panel custom metric in `web/app.js`**

Merge `natr`/`avgRange` into Task 3's existing metrics import line — change:

```js
import { createBarAggregator, selectCoins, paginate, pageCount, findTrendLines } from "./lib/metrics.js";
```

to:

```js
import { createBarAggregator, selectCoins, paginate, pageCount, findTrendLines, natr as clientNatr, avgRange as clientAvgRange } from "./lib/metrics.js";
```

(don't add a second `import ... from "./lib/metrics.js"` line — one merged import, matching this file's established convention from Task 3.)

```js
const customMetrics = new Map(); // symbol -> { intervalLabel, natr, range }

async function fetchCustomMetric(sym, interval, limit) {
  const r = await fetch(`/api/candles?symbol=${sym}&interval=${interval}&limit=${limit}`);
  if (!r.ok) return null;
  const candles = await r.json();
  return { intervalLabel: `${interval}/${limit}`, natr: clientNatr(candles), range: clientAvgRange(candles) };
}

function openPeriodPopover(anchorEl, sym) {
  document.querySelector(".periodPopover")?.remove();
  const pop = document.createElement("div");
  pop.className = "periodPopover";
  const rect = anchorEl.getBoundingClientRect();
  pop.style.left = rect.left + "px";
  pop.style.top = (rect.bottom + 4) + "px";
  pop.innerHTML =
    `<select class="ivl"><option value="1m">1m</option><option value="5m" selected>5m</option><option value="15m">15m</option><option value="1h">1h</option></select>` +
    `<input class="cnt" type="number" value="14" min="2" max="500">` +
    `<button class="btn go">Go</button>`;
  pop.querySelector(".go").onclick = async () => {
    const interval = pop.querySelector(".ivl").value;
    const limit = Math.max(2, Math.min(500, +pop.querySelector(".cnt").value || 14));
    const metric = await fetchCustomMetric(sym, interval, limit);
    if (metric) { customMetrics.set(sym, metric); renderBoardGrid(); renderCoinList(); }
    pop.remove();
  };
  document.body.appendChild(pop);
  setTimeout(() => document.addEventListener("click", function close(e) {
    if (!pop.contains(e.target) && e.target !== anchorEl) { pop.remove(); document.removeEventListener("click", close); }
  }), 0);
}
```

In `makePanel(sym)` (from Task 3, extended in Task 5), add a NATR/Range line with a click-to-customize affordance. Change the panel header `innerHTML` to include a metrics row:

```js
  el.innerHTML =
    `<div class="panelHead"><span class="freshDot"></span><span class="sym" style="cursor:pointer"></span>` +
    `<span class="tag"></span><span class="spacer"></span><span class="chg"></span></div>` +
    `<div class="panelHead metricsRow" style="cursor:pointer" title="Click to customize NATR/Range period"><span class="natr"></span><span class="range"></span></div>` +
    `<canvas></canvas>`;
  el.querySelector(".metricsRow").onclick = e => openPeriodPopover(e.target, sym);
```

In `renderBoardGrid()`'s per-coin loop (from Task 3), after setting `.chg`, display either the custom metric (if the user picked one for this symbol) or the server's default `c.n`/`c.r`:

```js
    const cm = customMetrics.get(c.s);
    const natrEl = p.el.querySelector(".natr"), rangeEl = p.el.querySelector(".range");
    natrEl.textContent = cm ? `NATR ${cm.intervalLabel}: ${cm.natr?.toFixed(1) ?? "—"}` : `NATR: ${c.n?.toFixed(1) ?? "—"}`;
    rangeEl.textContent = cm ? `Rng: ${cm.range?.toFixed(1) ?? "—"}` : `Rng: ${c.r?.toFixed(1) ?? "—"}`;
```

- [ ] **Step 3: Manual verification**

Run: `npm run mock`, open `http://localhost:8080`.

Verify:
- Each panel shows a NATR/Range row using the server's default period.
- Clicking that row opens a small popover; pick e.g. "15m" / count 14, click Go — the panel's NATR/Range line updates to show the custom period label and a recomputed value, distinct from other panels which still show the default.
- Open the Network tab in devtools while clicking Go — confirm a `GET /api/candles?...` request fires and returns 200.
- No console errors.

- [ ] **Step 4: Commit**

```bash
git add web/index.html web/app.js
git commit -m "feat: add per-panel arbitrary-period NATR/Range control via /api/candles"
```

---

### Task 7: Grid density, pagination, AUTO mode, refresh, timeframe controls

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`

**Interfaces:**
- Produces: top-bar controls wired to the `gridDensity`/`gridPage`/`timeframe`/`aggregator` state already established in Task 3.

- [ ] **Step 1: Add the control markup**

In `web/index.html`, inside `<header>`, right after the `tagPills` div added in Task 5, add:

```html
  <div class="boardControls" id="boardControls">
    <select id="timeframeSel">
      <option value="1M">1M</option>
      <option value="5M" selected>5M</option>
      <option value="15M">15M</option>
    </select>
    <button class="wlBtn" id="autoMode" title="Auto-advance pages">AUTO</button>
    <button class="wlBtn" id="gridRefresh" title="Re-sort and refresh now">⟳</button>
    <select id="gridDensitySel">
      <option value="3">3</option>
      <option value="6">6</option>
      <option value="9" selected>9</option>
    </select>
    <button class="wlBtn" id="gridPrev">‹</button>
    <span class="dim" id="gridPageLabel">1/1</span>
    <button class="wlBtn" id="gridNext">›</button>
  </div>
```

CSS: `.boardControls{display:flex;gap:6px;align-items:center}` appended to `<style>`.

- [ ] **Step 2: Wire the controls in `web/app.js`**

```js
$("timeframeSel").addEventListener("change", e => {
  timeframe = e.target.value;
  aggregator = createBarAggregator(TIMEFRAMES[timeframe]);
  trendLinesBySym.clear();
  barCountBySym.clear();
  renderBoardGrid();
});

$("gridDensitySel").addEventListener("change", e => {
  gridDensity = +e.target.value;
  gridPage = 0;
  renderBoardGrid();
});

$("gridPrev").onclick = () => { gridPage = Math.max(0, gridPage - 1); renderBoardGrid(); };
$("gridNext").onclick = () => { gridPage += 1; renderBoardGrid(); };
$("gridRefresh").onclick = () => renderBoardGrid();

let autoTimer = null;
$("autoMode").onclick = () => {
  const on = !$("autoMode").classList.contains("on");
  $("autoMode").classList.toggle("on", on);
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (on) autoTimer = setInterval(() => { $("gridNext").click(); }, 8000);
};
```

Update `renderBoardGrid()` (from Task 3) to publish the page label, replacing the line that currently only computes `pages`/`gridPage` internally — add right after `gridPage = Math.min(gridPage, pages - 1);`:

```js
  $("gridPageLabel").textContent = `${gridPage + 1}/${pages}`;
```

- [ ] **Step 3: Manual verification**

Run: `npm run mock`, open `http://localhost:8080`.

Verify:
- Grid density selector switches between 3/6/9 panels per page, reflowing the 3-column grid to 1/2/3 rows.
- Prev/Next arrows page through the filtered/sorted coin list; the page label (e.g. "2/7") updates correctly, including with a smaller grid density (more pages).
- Clicking AUTO starts auto-advancing pages every ~8s (watch the page label tick up); clicking again stops it.
- Changing the timeframe selector (e.g. 5M → 1M) clears all existing bars and trend lines and starts fresh accumulation at the new bar width (panels visibly reset to a mostly-empty chart, then refill).
- The refresh (⟳) button immediately re-sorts/re-pages without waiting for the next tick.
- No console errors.

- [ ] **Step 4: Commit**

```bash
git add web/index.html web/app.js
git commit -m "feat: add grid density, pagination, AUTO-advance, refresh, and timeframe controls"
```

---

### Task 8: Final integration pass

- [ ] **Step 1: Full manual click-through**

Run: `npm run mock`, open `http://localhost:8080`, and go through every feature built across Tasks 1-7 in one sitting:
- Board is the default tab; grid shows live charts with trend lines; sidebar shows Coin List/Density Map/Listings; sidebar collapses/expands.
- Tag a few coins with different colors, filter by tag, reload and confirm persistence.
- Customize one panel's NATR/Range period.
- Change grid density, page through, toggle AUTO, change timeframe, hit refresh.
- Switch to Screener/Density/Alerts tabs and confirm they still work exactly as before this plan started (Task 1's refactor didn't regress them, and none of Tasks 2-7 touched their code paths).
- Check the browser console for any errors across the whole session.

- [ ] **Step 2: Run the automated suite (regression check for the foundation plan's work)**

Run: `npm test`
Expected: all 9 suites still pass (this plan didn't touch any tested backend/pure-logic code, so this should be unaffected, but confirm).

- [ ] **Step 3: Confirm no stray files**

Run: `git status`
Expected: working tree clean.

## What This Completes

With this plan done, the Board View feature (`docs/superpowers/specs/2026-07-12-board-view-design.md`) is fully implemented: a live multi-chart grid with trend lines as the default view, a collapsible Coin List/Density Map/Listings sidebar, multi-color tagging, and arbitrary-period NATR/Range — all built on the tested foundation from the prior plan.
