# HiDPI Canvas Fix & Coin Detail View

**Date:** 2026-07-13
**Status:** Approved for planning

## Context

Two follow-ups from using the Board View feature:

1. Chart panels look jagged/pixelated on high-DPI displays — the canvas
   backing-store resolution is set to CSS pixel size, not accounting for
   `devicePixelRatio`.
2. There's no way to focus on a single coin with a larger, independently
   controllable chart — clicking a coin in the sidebar Coin List should
   expand its chart to fill the whole grid area with its own timeframe
   selector, separate from the grid's global one.

## Goals

1. Charts render crisply on any display scaling factor.
2. Clicking a coin in the Coin List sidebar replaces the grid area with one
   large chart for that coin, with an independent 1m/5m/1h/4h timeframe
   selector and a close/back control, while the sidebar itself stays
   visible and clicking a different coin switches directly to it.

## Non-goals

- No change to the main 3/6/9 grid's own behavior, controls, or global
  timeframe selector.
- No change to how grid panels handle clicks (tag popover, custom-period
  popover stay exactly as they are).
- The detail view's timeframe selector offers only 1m/5m/1h/4h (not the
  full 1m/5m/15m/30m/1h/4h/1d set the global selector has) — matching
  what was actually requested, a focused/reduced set for quick reference.

## 1. HiDPI Canvas Fix

`web/lib/chart.js`'s `drawPanel` already computes every position, font
size, and line width proportionally from `canvas.width`/`canvas.height` —
it never hardcodes a pixel value. That means the fix is entirely
contained to how `web/app.js` sizes the canvas's backing store:

In `drawPanelFor` (`web/app.js:298-305`), change:

```js
const rect = p.canvas.getBoundingClientRect();
const w = Math.round(rect.width), h = Math.round(rect.height);
if (w > 0 && (p.canvas.width !== w || p.canvas.height !== h)) { p.canvas.width = w; p.canvas.height = h; }
```

to multiply by `window.devicePixelRatio` when setting the backing store
size, while the canvas's CSS-rendered size stays governed by the existing
`.panel canvas{width:100%}` rule (unaffected) — the browser downscales the
higher-resolution backing store to fit, and since every draw call in
`chart.js` is already proportional to `canvas.width`/`canvas.height`,
everything scales up consistently with zero changes to that file.

This same fix applies to the new detail-view canvas (section 2) since it
uses the same `drawPanel` renderer.

## 2. Coin Detail View

### Trigger and layout

`renderCoinList()` (`web/app.js:385-391`) currently renders plain text via
`innerHTML` with no interactivity. It gains a click listener (event
delegation on `#coinListBody`, since rows are rebuilt on every snapshot)
that reads which symbol was clicked and calls `openDetailView(sym)`.

`#boardGrid`'s container gets a sibling `#boardDetail` element (hidden by
default), containing: a header (coin symbol, a close button, and a
`<select>` with `1m`/`5m`/`1h`/`4h` options), and one large `<canvas>`.
`openDetailView(sym)` hides `#boardGrid` and shows `#boardDetail` (CSS
class toggle, matching the existing `.view`/`.on` pattern already used for
top-level tabs); `closeDetailView()` reverses it. Clicking a different coin
row while already in detail view calls `openDetailView(newSym)` directly —
no need to close first.

### Independent state and data flow

Module-level state, separate from the grid's shared `aggregator`:

```js
let detailSym = null;
let detailTimeframe = timeframe; // defaults to whatever the global timeframe currently is, at open time
let detailAggregator = null;
```

`openDetailView(sym)`: sets `detailSym = sym`, creates a fresh
`detailAggregator = createBarAggregator(TIMEFRAMES[detailTimeframe])`,
fetches real history via the same `/api/candles` + `seedBars` pattern
`seedHistory` already uses (parameterized to target `detailAggregator`
instead of the shared `aggregator`), and renders once immediately (same
"redraw right after seed resolves" pattern already used for grid panels,
avoiding the blank-until-next-snap flicker).

The existing `snap` handler (`web/app.js:39-45`) gains one more line:
when `detailSym` is set, feed that same tick data into
`detailAggregator` and redraw the detail canvas — reusing the coin's
price from the same `coins` snapshot already being processed for the
grid, no new WebSocket data needed.

Changing the detail view's own timeframe `<select>` rebuilds
`detailAggregator` at the new interval and re-seeds — same pattern as the
global timeframe selector, just scoped to `detailAggregator`/`detailSym`
instead of the shared grid state.

### Rendering

The detail canvas calls the exact same `drawPanel(canvas, {bars, price,
symbol, trendLines, walls})` grid panels use — same trend-line and
wall-overlay logic, just a much larger canvas. Trend lines are computed
the same way (`findTrendLines`, recomputed on bar close, tracked via the
same kind of "last bar timestamp" gate `lastBarTsBySym` uses for grid
panels — a parallel `detailLastBarTs` variable). Wall data reuses the
existing `topWallsFor(sym)` helper unchanged.

## Testing

- HiDPI fix: no automated test (canvas rendering) — verified manually via
  real headless-browser screenshot comparison (checking the canvas
  backing-store dimensions scale with a simulated `devicePixelRatio`).
- Detail view: DOM/fetch/state wiring, no automated test coverage, per
  this project's established non-goal for that category — verified via
  the same real headless-Chromium (`playwright-core` + cached Chromium)
  approach used throughout prior UI work: open a coin's detail view,
  confirm the grid hides and a large chart appears with real history,
  switch its timeframe and confirm an independent re-fetch happens
  without affecting the grid's global timeframe, click a different coin
  to confirm direct switching, close and confirm the grid returns exactly
  as it was.

## Open Items for the Implementation Plan

- Exact detail-view header/canvas CSS layout (reasonable defaults
  proposed, confirm visually during implementation).
- Whether the detail view's canvas needs its own resize-observer-driven
  redraw (like grid panels get via the periodic snap-driven redraw) or a
  one-time size calculation is sufficient given it fills a fixed-layout
  area — confirm at plan time.
