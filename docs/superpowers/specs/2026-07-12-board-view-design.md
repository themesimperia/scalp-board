# TapeBoard "Board View" — Multi-Chart Grid UI

**Date:** 2026-07-12
**Status:** Approved for planning

## Context

TapeBoard's current web UI (`web/index.html`) is a single-file app with three tab
views: a sortable table Screener, a bubble-lane Density map, and an Alerts manager.
The user wants to replace the Screener with a "board view" modeled on a reference
screenshot: a paginated grid of live mini candlestick charts (one per ticker), with
a collapsible panel (Coin List / Density Map / Listings) on the **left** and the
chart grid on the **right** — the reverse of the reference screenshot's own layout,
per explicit user preference.

This works against **today's single-process server** (`server/index.js` +
`server/core/*`), not the future microservice split described in
`docs/superpowers/specs/2026-07-12-engine-hardening-design.md`. That effort is
still mid-flight (only its "Shared Foundation" plan is built so far). This UI
work is independent of it and will simply carry forward when the aggregator
service is eventually built.

## Goals

1. Replace the Screener tab with a paginated grid of live mini candlestick charts.
2. Add a collapsible left panel: Coin List, Density Map (re-laid-out), Listings feed.
3. Add multi-color ticker tagging (extends today's single-star watchlist).
4. Add an on-demand, per-symbol, arbitrary-period NATR/Range control.
5. Add support/resistance trend lines to each chart panel.
6. Keep the existing Alerts tab unchanged.
7. Keep the project's zero-build-step, minimal-dependency philosophy.

## Non-goals

- No new backend candle-history/SQLite persistence (that's separate, already
  spec'd, not-yet-built phase-1 work) — the `/api/candles` endpoint fetches
  live from the exchange (briefly cached), not from stored history.
- No theming system, i18n, or fullscreen chrome beyond what's trivial — icons
  in the reference screenshot for these are out of scope unless called out.
- No automated visual/canvas-rendering tests (see Testing section).

## 1. Overall Layout

Top-level nav becomes two tabs: **Board** (new default) and **Alerts** (existing,
unchanged). Board is a two-column layout:

- **Left (fixed ~320px, collapsible):** three stacked panels — Coin List, Density
  Map, Listings. A toggle button collapses/hides this whole column, and the chart
  grid reflows to reclaim the freed width. Expanded by default.
- **Right (majority width):** paginated grid of live mini-chart panels.

The top bar keeps today's search / min-volume / watchlist controls, plus new
Board-specific controls (below).

## 2. Client-Side Candle Aggregation

No new backend endpoint feeds the live chart panels — bars are built in the
browser from the existing 1/sec `snap` price stream:

- Each tracked symbol (not just the current page's visible symbols) accumulates
  OHLC bars continuously in the background, for the selected timeframe (default
  5m). A tick updates the currently-forming bar; crossing a bar-boundary closes
  it and opens a new one (`o` = previous `c`).
- Bar history per symbol is capped (e.g. last 200 bars) to bound memory over a
  long session.
- Charts start empty on page load and fill in as ticks arrive — there's no
  history before the page was opened, for symbols built this way. This is an
  accepted limitation of building bars from live ticks rather than fetching
  history.
- Switching the timeframe selector clears and restarts accumulation for all
  symbols (no raw tick history is kept to re-bucket into a different width).
- A volume-per-bar accumulator rides alongside `o/h/l/c` for the volume
  histogram strip (section 3).

## 3. Chart Panel Component (Canvas)

Hand-rolled Canvas 2D renderer — no charting library, matching the project's
existing zero-JS-dependency style. Each grid cell:

- **Header row:** ticker, exchange tag (`EX_TAG` mapping, reused as-is), 24h
  change %, range, NATR, volume — same fields/formatting the screener table
  already renders per row.
- **Chart area:** `<canvas>` drawing candle bodies/wicks (existing `--up`/`--down`
  CSS colors), a dashed horizontal current-price line, and a large low-opacity
  ticker-symbol watermark drawn behind the candles.
- **Volume histogram:** thin bar strip along the canvas bottom, one bar per
  candle, height scaled to that bar's accumulated volume.
- **Redraw cadence:** on every incoming tick for that symbol, gated by an
  `IntersectionObserver` per panel so off-screen panels don't waste redraws.
- **Status dot:** data-freshness indicator — green while ticks are arriving
  normally for that symbol, gray/red if its feed has gone stale (no tick within
  some threshold). This is a best-effort read of the reference screenshot's
  small corner dot; confirmed with the user as the intended meaning over
  alternatives (alert-armed indicator, price-direction indicator).
- **Support/resistance trend lines** (best-fit selection algorithm):
  1. **Pivot detection:** a bar is a swing high if its high exceeds the highs of
     the 2 bars on each side within the visible bar window (mirrored for swing
     lows).
  2. **Candidate lines:** every pair of swing highs forms a candidate resistance
     line (straight line through those two points, extended to the chart's right
     edge). Every pair of swing lows forms a candidate support line.
  3. **Scoring:** each candidate's touch count = how many *other* swing highs
     (or lows, for support) fall within a small tolerance (~0.15% of price) of
     the line's value at their bar index.
  4. **Validity filter:** a candidate is disqualified if any bar's close breaks
     meaningfully through it (resistance: a close above the line between/after
     its defining points; support: a close below).
  5. **Winner:** the valid candidate with the highest touch count (ties broken
     toward the more recent pair) is drawn as the resistance line; the same
     process independently picks the support line.
  6. Recomputed when bars close, not on every tick (trend lines shouldn't jitter
     in real time). Omitted if too few swing points exist yet for a symbol.
  - This is a real pairwise best-fit selection (not just connecting the 2 most
    recent pivots) but stays O(n²) over a small n (swing-point counts in a small
    chart window are naturally in the single-to-low-double digits), so it's
    cheap even across many simultaneously-rendering panels.

## 4. Grid, Pagination & Top Bar

- **Grid density:** fixed 3-column layout, selectable row count of 1/2/3 (3, 6,
  or 9 panels total per page), via a small grid-icon control — matches the
  reference screenshot's "3/6/9 windows" exactly.
- **Sort & filter:** reuses the exact sort-key/search/min-volume/watchlist state
  the table view already has — the grid is a different rendering of the same
  filtered/sorted list, sliced into pages instead of table rows.
- **Pagination:** prev/next arrows + page indicator (e.g. "1/7"), paging the
  filtered/sorted list at the current grid density.
- **"AUTO" mode:** auto-advances to the next page on a timer (~8s), for passive
  monitoring. Adjacent refresh icon forces an immediate re-sort/re-page.
- **Timeframe control ("5M"):** sets the mini-chart bar width (feeds section 2).
- **NATR/Range period controls:** real, per-symbol, arbitrary-period selectors —
  see section 5. Not fixed presets; the user can pick any interval/period
  combination the underlying exchange kline endpoints support.
- **Color-tag filters:** "ALL" + N color pills filter the grid/coin-list by tag
  (section 6) rather than being cosmetic.

## 5. Backend: On-Demand Candle Endpoint

New endpoint, `server/index.js`:

```
GET /api/candles?symbol=BTC&interval=15m&limit=60
```

- Looks up the coin's current best-source exchange (`market.coins.get(base)`,
  `c.best` — same lookup pattern `klines.js`/`density.js` already use), then
  calls that connector's existing `fetchKlines(sym, interval, limit)` — already
  implemented generically across Binance/Bybit/OKX/mock. No new
  exchange-integration code.
- **Server-side cache**, keyed by `(exchange, symbol, interval)`, ~30-60s TTL —
  a plain `Map` with timestamps, no new dependency — protects exchange rate
  limits against repeated/multi-client requests for the same series.
- Returns the same `[{h,l,c}]` shape `fetchKlines` already produces (oldest→
  newest), so the client can feed it straight into the same metric functions.

**Client-side computation:** `natr()`/`avgRange()` get a client-side copy (they're
already pure, zero-dependency, ~10 lines each) in `web/lib/metrics.js`. When a
user picks a period for a symbol, the client calls `/api/candles`, then computes
the metric itself — the server never needs to know about "presets"; each user
can view a different period without server-side per-client state.

This sits alongside (not replacing) the existing default 5m/14 NATR + 1m/5 Range
the server already computes and broadcasts to everyone via `snap` — that stays
as the sensible pre-customization default.

## 6. Sidebar Panels

- **Coin List:** compact version of today's screener table (Ticker / Change /
  Range / NATR / Vol / Trades), same sort/filter state as the main grid, dense
  list layout instead of a full-width table.
- **Density Map:** re-buckets the existing `walls` array (already computed
  server-side, unchanged) into **Large / Medium / Small** columns by notional
  size (e.g. thresholds at $1M / $300K), each wall shown as a small badge
  (`EX_TAG SYMBOL SIZE`) instead of today's bubble-lane visualization. Same
  underlying data, different at-a-glance layout.
- **Listings:** dedicated feed of `"listing"` alert-engine events (already
  emitted via `AlertEngine.onListing`), filtered out of the general alert feed
  into their own panel — ticker / market / time-since-listed.

## 7. Color-Tag Data Model

Extends today's single `watch` Set (localStorage `tb.watch`) into a
`Map<symbol, tagColor>` (new localStorage key `tb.tags`), e.g.
`{"BTC": "green", "ETH": "red"}`. The "ALL" pill + color pills in the top bar
filter the grid/coin-list to `all` or `tag === color`. Assigning a tag happens
via a small color-picker popover on each panel/row, replacing today's single ★.

## 8. File Structure

Splitting out of the single inline-script HTML file, still zero-build-step
(native ES modules via `<script type="module">`, server keeps serving static
files as-is):

- `web/index.html` — markup + CSS only.
- `web/lib/metrics.js` — pure functions: `natr`/`avgRange` (client copies),
  candle-bar aggregation reducer, pagination/filter/tag helpers. Shared between
  the browser and Node tests, mirroring how `server/core/metrics.js` works.
- `web/lib/chart.js` — canvas draw routine for one panel.
- `web/app.js` — WebSocket handling, state, rendering orchestration, event
  wiring.

## 9. Testing

Matching the project's existing plain-`node:assert`, no-framework style:

- `test/web.metrics.test.js` — unit tests for `web/lib/metrics.js`'s pure
  functions (candle aggregation from a synthetic tick sequence, pagination math,
  tag filtering).
- `test/server.candles.test.js` — real HTTP round-trip test of the new
  `/api/candles` endpoint and its cache, using the mock exchange connector (no
  real network calls), following the same pattern as `test/lib.health.test.js`.
- **Canvas rendering and visual layout are not automated** — a headless-browser
  dependency (e.g. Puppeteer) to pixel-test canvas output would contradict this
  project's minimal-dependency philosophy for a low payoff here. Verification is
  manual: run `npm run mock`, look at it in the browser.

## Open Items for the Implementation Plan

- Grid density is finalized: fixed 3 columns, 1/2/3 rows (3/6/9 panels), default
  9. No further decision needed here.
- Exact color palette for tags (beyond the 3 shown in the reference: red/green/
  purple) and the popover UI for assigning them.
- Exact thresholds for Density Map's Large/Medium/Small buckets.
- Auto-advance timer duration for "AUTO" mode (proposed ~8s, confirm at plan
  time).
- Swing-point pivot window size (proposed 2 bars each side) and touch tolerance
  (proposed ~0.15% of price) for the trend-line algorithm — reasonable defaults
  proposed, confirm/tune at plan time or after first manual test.
