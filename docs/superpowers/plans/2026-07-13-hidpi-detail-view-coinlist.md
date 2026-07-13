# HiDPI Fix, Coin Detail View & Coin List Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix jagged canvas rendering on HiDPI displays, add a per-coin detail chart view (opened from the Coin List sidebar, own independent timeframe) that fills the grid area, and expand the Coin List sidebar to show Change/Range/NATR/Trades/Vol with sortable headers and a tag-color bar.

**Architecture:** All changes are in `web/app.js` and `web/index.html` — no backend changes, no changes to `web/lib/chart.js` (its drawing math is already proportional, and it already accepts the exact `{bars, price, symbol, trendLines, walls}` shape both the grid panels and the new detail view need) or `web/lib/metrics.js` (its existing `createBarAggregator`/`selectCoins`/`findTrendLines` are reused as-is for the detail view, matching how the grid already uses them).

**Tech Stack:** Plain vanilla JS/ES modules, Canvas 2D, no new dependencies.

## Global Constraints

- ES modules only, no build step, no new dependencies.
- No test framework; this entire plan is DOM/canvas/fetch wiring with no automated test coverage, per this project's established non-goal for that category. Every task's verification is a real headless-Chromium browser session (`playwright-core` pointed at the machine's cached Chromium binary, e.g. `C:/Users/<user>/AppData/Local/ms-playwright/chromium-*/chrome-win/chrome.exe` — locate the exact cached version if the path differs) driving the actual running `npm run mock` server — not a claim of manual verification without evidence.
- Match existing code style: no comments except where genuinely non-obvious.
- Reuse existing helpers/conventions exactly: `$`, `EX_TAG`, `fmtPx`, `fmtBig`, `TIMEFRAMES`, `tagMap`'s color-to-CSS-variable mapping (`web/app.js:336-337`), the `.view`/`.on` and `.collapsed`/`on` class-toggle conventions already used for tabs and the sidebar, and the existing `seedHistory`/`aggregatorGen` stale-response-guard pattern (`web/app.js:216-229`).
- Files touched: `web/app.js` (modify), `web/index.html` (modify). No new files.

---

### Task 1: HiDPI canvas fix

**Files:**
- Modify: `web/app.js:298-305` (`drawPanelFor`)

**Interfaces:**
- No new exports — internal change only. `drawPanel` in `web/lib/chart.js` is NOT modified; it already computes everything proportionally from `canvas.width`/`canvas.height`.

- [ ] **Step 1: Apply the fix**

Change `drawPanelFor` from:

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

to:

```js
function drawPanelFor(sym, price) {
  const p = panelEls.get(sym);
  if (!p) return;
  const rect = p.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
  if (w > 0 && (p.canvas.width !== w || p.canvas.height !== h)) { p.canvas.width = w; p.canvas.height = h; }
  drawPanel(p.canvas, { bars: aggregator.getBars(sym), price, symbol: sym, trendLines: trendLinesBySym.get(sym), walls: topWallsFor(sym) });
}
```

- [ ] **Step 2: Manual verification**

Run `npm run mock`. Using a `playwright-core` script (scratch directory, not the project), launch with `deviceScaleFactor: 2` (default headless Chromium is 1, so this is required to actually exercise the fix):

```js
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
```

Navigate to `http://localhost:8080/`, wait for panels to render, then evaluate in-page:

```js
const ratio = await page.locator("#boardGrid .panel canvas").first().evaluate((c, dpr) => {
  const rect = c.getBoundingClientRect();
  return { canvasWidth: c.width, cssWidth: rect.width, dpr };
}, await page.evaluate(() => window.devicePixelRatio));
console.log(ratio);
```

Confirm `canvasWidth ≈ cssWidth * dpr` (previously `canvasWidth === cssWidth` regardless of `dpr`). Take a screenshot and visually confirm candle edges look crisper than before at 2x scale factor (compare a `deviceScaleFactor: 1` screenshot vs. a `deviceScaleFactor: 2` screenshot of the same panel).

- [ ] **Step 3: Commit**

```bash
git add web/app.js
git commit -m "fix: scale canvas backing store by devicePixelRatio for crisp HiDPI rendering"
```

---

### Task 2: Coin List columns + tag-color bar

**Files:**
- Modify: `web/index.html` (CSS for `.clRow`)
- Modify: `web/app.js:385-391` (`renderCoinList`)

**Interfaces:**
- Produces: each `.clRow` gains a `data-sym="<symbol>"` attribute (consumed by Task 4's click wiring) and a `border-left-color` reflecting the coin's tag, matching the exact color mapping already used for grid panels.
- Consumes: `c.r` (range), `c.n` (NATR), `c.t` (trades) — already present on every coin object from `selectCoins`'s snapshot data (same fields `renderScreener`'s table already displays), `fmtBig` (already handles `null` gracefully, returning `"—"`).

- [ ] **Step 1: Update the `.clRow` CSS**

In `web/index.html`, replace the existing `.clRow` rule:

```css
.clRow{display:flex;justify-content:space-between;gap:6px;padding:4px 8px;font-size:11px;border-bottom:1px solid #0f1d21}
```

with:

```css
.clRow{display:grid;grid-template-columns:1.3fr .8fr .6fr .6fr .8fr .8fr;gap:4px;padding:4px 8px;font-size:10px;border-bottom:1px solid #0f1d21;border-left:3px solid transparent;text-align:right}
.clRow > .s{text-align:left}
```

(the existing `.clRow .s{font-weight:700}` rule stays unchanged, right below it)

- [ ] **Step 2: Rewrite `renderCoinList`**

Replace:

```js
function renderCoinList() {
  if (!$("view-board").classList.contains("on")) return; // sidebar lives inside the Board view — skip when it's not visible
  const list = selectCoins(coins, boardOpts()).slice(0, 100);
  $("coinListBody").innerHTML = list.map(c =>
    `<div class="clRow"><span class="s">${c.s}</span><span class="${c.c>=0?'up':'down'}">${(c.c>0?'+':'')+c.c.toFixed(1)}%</span><span class="dim">${fmtBig(c.v)}</span></div>`
  ).join("") || `<div class="clRow dim">No coins match the current filters</div>`;
}
```

with:

```js
function renderCoinList() {
  if (!$("view-board").classList.contains("on")) return; // sidebar lives inside the Board view — skip when it's not visible
  const list = selectCoins(coins, boardOpts()).slice(0, 100);
  $("coinListBody").innerHTML = list.map(c => {
    const tagColor = tagMap.get(c.s);
    const borderVar = tagColor === "green" ? "--up" : tagColor === "red" ? "--down" : tagColor === "purple" ? "--tag-purple" : null;
    const style = borderVar ? ` style="border-left-color:var(${borderVar})"` : "";
    return `<div class="clRow" data-sym="${c.s}"${style}>` +
      `<span class="s">${c.s}</span>` +
      `<span class="${c.c >= 0 ? 'up' : 'down'}">${(c.c > 0 ? '+' : '') + c.c.toFixed(1)}</span>` +
      `<span>${c.r == null ? "—" : c.r.toFixed(1)}</span>` +
      `<span>${c.n == null ? "—" : c.n.toFixed(1)}</span>` +
      `<span class="dim">${fmtBig(c.t)}</span>` +
      `<span class="dim">${fmtBig(c.v)}</span>` +
    `</div>`;
  }).join("") || `<div class="clRow dim">No coins match the current filters</div>`;
}
```

- [ ] **Step 3: Manual verification**

Run `npm run mock`, drive a real headless browser:
- Confirm `#coinListBody .clRow` elements render 6 values per row (ticker, change, range, NATR, trades, vol) — assert via `page.locator("#coinListBody .clRow").first().locator("span").allTextContents()` and check length is 6 and values look sane (non-empty, numeric where expected).
- Tag a coin (via the existing panel-symbol-click tag popover), confirm the corresponding Coin List row's `border-left-color` (via `getComputedStyle`) matches the tag's color.
- Confirm `data-sym` attributes are present and match each row's displayed ticker.

- [ ] **Step 4: Commit**

```bash
git add web/index.html web/app.js
git commit -m "feat: expand Coin List sidebar with Range/NATR/Trades columns and tag-color bar"
```

---

### Task 3: Sortable Coin List header (shared sort state with the grid)

**Files:**
- Modify: `web/index.html` (new `#clHeadRow` markup + CSS)
- Modify: `web/app.js:480-486` (extract shared `applySort`/`syncSortHeaders`, replace the existing `#headRow` click handler, add `#clHeadRow`'s)

**Interfaces:**
- Produces: `applySort(key)` — toggles `sortDir` if `key === sortKey` (matching the existing toggle behavior exactly), else sets `sortKey = key` and resets `sortDir` (ascending for `"s"`, descending otherwise) — then re-renders `renderScreener()`, `renderBoardGrid()`, and `renderCoinList()`, and calls `syncSortHeaders()`.
- Produces: `syncSortHeaders()` — sets the `.sorted` CSS class on whichever child of `#headRow` and `#clHeadRow` has a matching `data-k`, keeping both headers visually in sync regardless of which one triggered the sort.
- Consumes: `sortKey`/`sortDir` (existing module-level state, unchanged), `renderScreener`/`renderBoardGrid`/`renderCoinList` (existing functions, unchanged).

- [ ] **Step 1: Add the `#clHeadRow` markup and CSS**

In `web/index.html`, inside `#panelCoinList` (right after `<h3>Coin list</h3>`, before `<div class="sideBody" id="coinListBody">`), add:

```html
        <div class="clHeadRow" id="clHeadRow">
          <span data-k="s">Ticker</span>
          <span data-k="c">Chg</span>
          <span data-k="r">Rng</span>
          <span data-k="n">NATR</span>
          <span data-k="t">Trades</span>
          <span data-k="v" class="sorted">Vol</span>
        </div>
```

Add CSS (near `.clRow`'s rules):

```css
.clHeadRow{display:grid;grid-template-columns:1.3fr .8fr .6fr .6fr .8fr .8fr;gap:4px;padding:6px 8px;font-size:9px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);border-bottom:1px solid var(--line);cursor:pointer;user-select:none;text-align:right}
.clHeadRow > span:first-child{text-align:left}
.clHeadRow span.sorted{color:var(--accent)}
```

- [ ] **Step 2: Extract the shared sort helper and wire both headers**

Replace the existing `#headRow` click handler:

```js
$("headRow").addEventListener("click", e => {
  const th = e.target.closest("th"); if(!th || !th.dataset.k) return;
  const k = th.dataset.k;
  if(sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = k === "s" ? 1 : -1; }
  [...$("headRow").children].forEach(x => x.classList.toggle("sorted", x === th));
  renderScreener();
});
```

with:

```js
function applySort(k) {
  if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = k === "s" ? 1 : -1; }
  syncSortHeaders();
  renderScreener();
  renderBoardGrid();
  renderCoinList();
}

function syncSortHeaders() {
  [...$("headRow").children].forEach(x => x.classList.toggle("sorted", x.dataset.k === sortKey));
  [...$("clHeadRow").children].forEach(x => x.classList.toggle("sorted", x.dataset.k === sortKey));
}

$("headRow").addEventListener("click", e => {
  const th = e.target.closest("th"); if(!th || !th.dataset.k) return;
  applySort(th.dataset.k);
});

$("clHeadRow").addEventListener("click", e => {
  const el = e.target.closest("span"); if(!el || !el.dataset.k) return;
  applySort(el.dataset.k);
});
```

- [ ] **Step 3: Manual verification**

Run `npm run mock`, drive a real headless browser:
- Click a Coin List column header (e.g. "Chg"), confirm both the Coin List rows AND the grid panels re-order consistently (compare the top symbol in both before/after).
- Confirm the `.sorted` class moves to the clicked header in `#clHeadRow`, AND the corresponding `<th>` in the Screener tab's `#headRow` also gets `.sorted` (switch to the Screener tab to check) — proving `syncSortHeaders` keeps both in sync.
- Click the Screener table's header instead, confirm `#clHeadRow`'s `.sorted` class updates to match.
- Click the same header twice, confirm sort direction reverses (compare row order between the two clicks).

- [ ] **Step 4: Commit**

```bash
git add web/index.html web/app.js
git commit -m "feat: add sortable Coin List headers sharing sort state with the grid and Screener table"
```

---

### Task 4: Coin detail view — layout, state, open/close

**Files:**
- Modify: `web/index.html` (new `#boardDetail` markup + CSS)
- Modify: `web/app.js` (new state variables, `openDetailView`/`closeDetailView`, Coin List click wiring)

**Interfaces:**
- Consumes: `TIMEFRAMES`, `createBarAggregator` (both already imported/declared), `data-sym` attribute on `.clRow` (from Task 2).
- Produces: module-level state `detailSym`, `detailTimeframe`, `detailAggregator`, `detailAggregatorGen`, `detailLastBarTs`, `detailTrendLines` — consumed by Task 5. `openDetailView(sym)`/`closeDetailView()` — Task 5 extends `openDetailView`'s body (this task creates it with a placeholder call to a function Task 5 defines; see Task 5's exact insertion point).

- [ ] **Step 1: Add the detail view markup and CSS**

In `web/index.html`, inside `.boardGridWrap` (right after `<div class="boardGrid" id="boardGrid"></div>`), add:

```html
        <div class="boardDetail" id="boardDetail">
          <div class="detailHead">
            <span class="sym" id="detailSymLabel"></span>
            <select id="detailTimeframeSel">
              <option value="1m">1m</option>
              <option value="5m" selected>5m</option>
              <option value="1h">1h</option>
              <option value="4h">4h</option>
            </select>
            <span class="spacer"></span>
            <button class="wlBtn" id="detailClose">✕ Close</button>
          </div>
          <canvas id="detailCanvas"></canvas>
        </div>
```

Add CSS:

```css
.boardDetail{display:none;flex-direction:column;height:100%}
.boardDetail.on{display:flex}
.boardGrid.hidden{display:none}
.detailHead{display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--line)}
.detailHead .sym{font-weight:700;font-size:14px}
.detailHead .spacer{flex:1}
#detailCanvas{flex:1;width:100%;display:block}
```

- [ ] **Step 2: Add detail-view state and open/close functions**

Near the other board-grid state declarations at the top of `web/app.js` (after `const panelEls = new Map();`), add:

```js
let detailSym = null;
let detailTimeframe = null; // null until the first-ever open, which sets it to the CURRENT global `timeframe` at that moment (not at page load) — then persists independently across coins/sessions
let detailAggregator = null;
let detailAggregatorGen = 0;
let detailLastBarTs = null;
let detailTrendLines = null;
```

Add the open/close functions (a good location is right after `makePanel`, before `topWallsFor`):

```js
function openDetailView(sym) {
  if (detailTimeframe === null) detailTimeframe = timeframe; // first-ever open takes whatever the global timeframe currently is
  detailSym = sym;
  $("detailSymLabel").textContent = sym;
  $("detailTimeframeSel").value = detailTimeframe;
  $("boardGrid").classList.add("hidden");
  $("boardDetail").classList.add("on");
  detailAggregator = createBarAggregator(TIMEFRAMES[detailTimeframe]);
  detailAggregatorGen++;
  detailLastBarTs = null;
  detailTrendLines = null;
  seedDetailHistory();
}

function closeDetailView() {
  detailSym = null;
  $("boardDetail").classList.remove("on");
  $("boardGrid").classList.remove("hidden");
}
```

(`seedDetailHistory` is defined in Task 5 — this task's code references it but Task 5 must land before this is runnable end-to-end; that's fine, both tasks are implemented in the same session before any verification step runs.)

- [ ] **Step 3: Wire the Coin List click and close button**

Near the other top-bar control wiring at the bottom of `web/app.js` (alongside `$("sideToggle").onclick = ...`), add:

```js
$("coinListBody").addEventListener("click", e => {
  const row = e.target.closest(".clRow");
  if (!row?.dataset.sym) return;
  openDetailView(row.dataset.sym);
});

$("detailClose").onclick = closeDetailView;
```

- [ ] **Step 4: Commit**

```bash
git add web/index.html web/app.js
git commit -m "feat: add coin detail view layout, state, and open/close wiring"
```

(No standalone manual-verification step here — Task 4's code isn't independently runnable until Task 5 defines `seedDetailHistory`/`renderDetailView`. Verification happens at the end of Task 5.)

---

### Task 5: Coin detail view — data fetching, live tick wiring, timeframe control

**Files:**
- Modify: `web/app.js` (`seedDetailHistory`, `renderDetailView`, detail timeframe selector wiring, `snap` handler extension)

**Interfaces:**
- Consumes: `detailSym`/`detailTimeframe`/`detailAggregator`/`detailAggregatorGen`/`detailLastBarTs`/`detailTrendLines` (Task 4), `findTrendLines`/`natr`/`avgRange` imports (already present), `topWallsFor` (existing, unchanged), `drawPanel` (existing, unchanged).
- Produces: a fully working detail view — real history on open, live updates via the existing WebSocket `snap` stream, independent timeframe switching.

- [ ] **Step 1: Add `seedDetailHistory` and `renderDetailView`**

Add these functions (a good location is right after `seedHistory`, before `openPeriodPopover`):

```js
async function seedDetailHistory() {
  const sym = detailSym, gen = detailAggregatorGen;
  try {
    const r = await fetch(`/api/candles?symbol=${sym}&interval=${detailTimeframe}&limit=200`);
    if (!r.ok) return;
    const candles = await r.json();
    if (gen !== detailAggregatorGen || detailSym !== sym) return;
    if (candles.length) {
      detailAggregator.seedBars(sym, candles);
      renderDetailView();
    }
  } catch { /* live ticks will still build the chart from here */ }
}

function renderDetailView() {
  if (!detailSym) return;
  const canvas = $("detailCanvas");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
  if (w > 0 && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; }
  const price = coins.find(c => c.s === detailSym)?.l;
  drawPanel(canvas, { bars: detailAggregator.getBars(detailSym), price, symbol: detailSym, trendLines: detailTrendLines, walls: topWallsFor(detailSym) });
}
```

- [ ] **Step 2: Wire the detail timeframe selector**

Near the existing `$("timeframeSel").addEventListener(...)` block, add:

```js
$("detailTimeframeSel").addEventListener("change", e => {
  detailTimeframe = e.target.value;
  detailAggregator = createBarAggregator(TIMEFRAMES[detailTimeframe]);
  detailAggregatorGen++;
  detailLastBarTs = null;
  detailTrendLines = null;
  seedDetailHistory();
});
```

- [ ] **Step 3: Extend the `snap` WebSocket handler**

Find the existing `snap` handler:

```js
    if(m.t === "snap"){
      coins = m.coins; renderStatus(m.status);
      lastSnapAt = Date.now(); // connection/feed-level freshness signal — see renderBoardGrid's stale dot
      $("klAge").textContent = m.klineTs ? Math.round((Date.now()-m.klineTs)/1000)+"s ago" : "loading…";
      renderScreener();
      feedAggregator(coins, Date.now());
      renderBoardGrid(); renderCoinList();
    } else if(m.t === "hello"){
```

Change it to also feed and redraw the detail view when one is open:

```js
    if(m.t === "snap"){
      coins = m.coins; renderStatus(m.status);
      lastSnapAt = Date.now(); // connection/feed-level freshness signal — see renderBoardGrid's stale dot
      $("klAge").textContent = m.klineTs ? Math.round((Date.now()-m.klineTs)/1000)+"s ago" : "loading…";
      renderScreener();
      feedAggregator(coins, Date.now());
      renderBoardGrid(); renderCoinList();
      if (detailSym) {
        const c = coins.find(x => x.s === detailSym);
        if (c) {
          detailAggregator.addTick(detailSym, Date.now(), c.l, 0);
          const bars = detailAggregator.getBars(detailSym);
          const latestBarT = bars.length ? bars[bars.length - 1].t : null;
          if (latestBarT !== detailLastBarTs) {
            detailLastBarTs = latestBarT;
            detailTrendLines = findTrendLines(bars);
          }
          renderDetailView();
        }
      }
    } else if(m.t === "hello"){
```

- [ ] **Step 4: Manual verification**

Run `npm run mock`, drive a real headless browser:
- Click a coin in the Coin List, confirm `#boardGrid` hides, `#boardDetail` shows, and the detail canvas has substantial real-history content (`toDataURL()` length check, matching the pattern used for grid panels' history verification).
- Confirm the detail canvas continues updating over a few seconds (data URL changes) as live ticks arrive.
- Change `#detailTimeframeSel` to a different value, confirm a new `/api/candles?...` request fires with the new interval and the chart re-renders with fresh history.
- While in detail view, click a DIFFERENT coin in the Coin List, confirm the view switches directly to the new symbol (still in detail mode, new symbol's history loads) without needing to close first.
- Click the Close button, confirm the grid reappears exactly as it was (same page/density/filter) and the detail view is hidden.
- Confirm the global `#timeframeSel` and grid panels are COMPLETELY unaffected by anything done in the detail view (their timeframe/history stays independent).
- Check console/page errors are empty throughout.

- [ ] **Step 5: Commit**

```bash
git add web/app.js
git commit -m "feat: wire coin detail view real history, live ticks, and independent timeframe control"
```

---

### Task 6: Final integration verification pass

- [ ] **Step 1: Full manual click-through**

Run `npm run mock`, drive a real headless browser through the combined feature set in one session:
- HiDPI fix still applies (canvas backing store scales with `devicePixelRatio`).
- Coin List shows all 6 columns with correct values and tag-color bars.
- Sorting via either header (Coin List or Screener) keeps both in sync and reorders the grid consistently.
- Opening, switching between, and closing the coin detail view all work correctly, with fully independent timeframe/history from the grid.
- Existing features from prior plans still work: tagging, custom NATR/Range periods, grid density/pagination/AUTO, Screener/Density/Alerts tabs.
- Zero console/page errors across the whole session.

- [ ] **Step 2: Run the automated regression suite**

Run: `npm test`
Expected: all 9 suites pass (this plan touches no backend/pure-logic code, so this confirms no regression).

- [ ] **Step 3: Confirm no stray files**

Run: `git status`
Expected: working tree clean.

## What This Completes

Charts render crisply on HiDPI displays, the Coin List sidebar is a full sortable data table matching the Screener table's richness with tag-color indicators, and clicking any coin opens a large, independently-controllable detail chart — all built on the existing tested `createBarAggregator`/`chart.js`/`selectCoins` foundation with no backend changes.
