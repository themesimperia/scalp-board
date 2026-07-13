# Board View Chart Panels — Real History, Wall Overlay, Timeframe Expansion

**Date:** 2026-07-13
**Status:** Approved for planning

## Context

The Board View feature (spec'd and built across two prior plans — engine-side
`/api/candles` foundation, then UI wiring) ships with a known, deliberately
accepted limitation from its original design: chart panels build candles
purely from live ticks starting at page load, so a panel shows a single
candle until enough time passes to accumulate real history. Comparing
against the reference screenshot makes this gap obvious — the reference
shows full price history immediately, plus order-book wall price levels
overlaid directly on the chart, and a much finer timeframe selection
(1m/5m/15m/30m/1h/4h/1d) than the current 1M/5M/15M.

This spec covers three related, chart-panel-scoped upgrades:

1. Real historical candles, fetched on demand and seeded into the existing
   live-tick pipeline (not a replacement of it).
2. Order-book wall price levels drawn directly on each panel's chart.
3. An expanded, exchange-aligned timeframe selector.

All three build entirely on infrastructure already in place — the
`/api/candles` endpoint (with its server-side cache and single-flight
protection), the existing `walls` data already broadcast over WebSocket,
and the existing global timeframe selector. No new backend endpoints, no
new WebSocket message types, no new dependencies.

## Goals

1. A panel shows real historical candles immediately when it becomes
   visible, not a single accumulating candle.
2. Live ticks continue to extend that real history seamlessly, exactly as
   they extend tick-built bars today.
3. Each panel's chart shows the top bid and top ask wall (if any) as
   labeled price-level lines, matching the reference screenshot.
4. The timeframe selector offers 1m/5m/15m/30m/1h/4h/1d, matching what the
   exchange kline APIs already support.

## Non-goals

- No change to the existing background tick-accumulation-for-all-tracked-
  coins behavior (explicitly kept as-is per user decision, not simplified
  even though real-history fetching would have allowed dropping it).
- No per-panel independent timeframes — stays a single global control.
- No change to how many walls appear in the sidebar Density Map or the
  legacy Density tab — this only adds wall lines to the Board grid's chart
  panels themselves.
- No backend changes — `/api/candles`, the exchange connectors, and the
  `density`/`walls` WebSocket data are all reused as-is.

## 1. Historical Data Flow

`web/lib/metrics.js`'s `createBarAggregator` (already built, tested, and
reviewed in the foundation plan) gains one new exported method:

```
seedBars(symbol, historicalBars)
```

`historicalBars` needs to arrive in the aggregator's own bar shape
(`{t,o,h,l,c,v}`) so a live tick can seamlessly extend the last seeded bar
via the existing bucket-matching logic in `addTick`. `/api/candles`
currently returns only `{h,l,c}` per candle (it proxies each exchange
connector's `fetchKlines`, which today discards open time and open price —
`server/core/metrics.js`'s `natr`/`avgRange` never needed them).
**This requires a small backend addition**: each connector
(`server/exchanges/{binance,bybit,okx,mock}.js`) already receives open
time and open price in the raw kline response it fetches — e.g. Binance's
array format is `[openTime, open, high, low, close, volume, ...]`, and
`fetchKlines` currently maps only indices 2-4 (`h,l,c`). Extend the
returned shape to `{t,o,h,l,c}` (indices 0,1,2,3,4), a non-breaking
additive change: `natr`/`avgRange` destructure only the fields they use,
so extra `t`/`o` properties on each candle object don't affect them.

`seedBars` replaces that symbol's bar array outright with the fetched
history (capped to `maxBars`, same cap as live-accumulated bars) — real
history is authoritative when it's available. Because each seeded bar's
`t` aligns to the same interval-boundary bucketing `addTick` already
computes (`Math.floor(ts/intervalMs)*intervalMs`), a subsequent live tick
naturally extends the last seeded (currently-forming) bar rather than
creating a duplicate — no special-case merge logic needed.

**When fetching happens**, in `web/app.js`:
- A panel is created (enters the visible grid page) and doesn't yet have
  seeded history for the current timeframe.
- The global timeframe selector changes — every currently-visible panel
  re-fetches at the new interval (in addition to the existing aggregator
  rebuild/trend-line-clear behavior already wired in Task 7).

Each fetch is `GET /api/candles?symbol=<sym>&interval=<current timeframe>&limit=200`
(200 to match the aggregator's existing `maxBars` default, keeping the
seeded history consistent with the cap it'll live under). Up to 9 panels
can fetch concurrently on a page load or timeframe change; this is safe
under the existing endpoint's short-TTL cache and single-flight protection
(both already built and reviewed in the foundation plan) — concurrent
requests for the same symbol/interval/limit collapse into one upstream
fetch, and repeated requests within the TTL window are served from cache.

## 2. Wall Price-Level Overlay

No new data source — reuses the `walls` array already broadcast via the
existing `density` WebSocket message and already rendered in both the
legacy Density tab and the Board sidebar's Density Map panel.

For each chart panel, `web/app.js` filters `walls` to that panel's symbol
and selects the single largest bid wall and single largest ask wall (by
`usd` notional) within the existing wall-detection distance threshold —
matching the reference screenshot's "top wall per side" presentation.

`web/lib/chart.js`'s `drawPanel` gains a new optional parameter,
`walls: { bid, ask }` (either may be `null` if no significant wall exists
on that side). Each present wall draws as a horizontal dashed line at its
price (distinct color from the existing solid current-price line — muted
`--down` red for ask, muted `--up` green for bid, matching the existing
palette), with a small labeled box anchored at the line's right edge
showing `EX_TAG SIZE PRICE` (e.g. `BI-F 200K 0.004950`), styled after the
reference screenshot's boxes.

## 3. Timeframe Selector Expansion

`#timeframeSel` (already built in Task 7) expands from its current
`1M/5M/15M` options to `1m/5m/15m/30m/1h/4h/1d` — verified against the
existing exchange connectors' `fetchKlines(sym, interval, limit)` calls,
which already accept exactly these interval strings for
Binance/Bybit/OKX/mock. Default stays `5m` (matches the server's own
default NATR/Range computation window, unchanged).

Changing the timeframe: rebuilds the background `aggregator` at the new
bar width, clears trend-line/bar-tracking state (both already wired in
Task 7), **and** now additionally triggers a re-fetch+reseed of real
history (section 1) for every currently-visible panel at the new interval.

## File Structure

- `server/exchanges/{binance,bybit,okx,mock}.js` — `fetchKlines` return
  shape gains `t` and `o` fields per candle (additive, non-breaking).
- `web/lib/metrics.js` — `createBarAggregator` gains `seedBars(symbol, bars)`.
- `web/lib/chart.js` — `drawPanel` gains the `walls` param and wall-line
  drawing logic.
- `web/app.js` — new fetch-on-panel-visible / fetch-on-timeframe-change
  logic; per-panel wall filtering; `#timeframeSel`'s option list.
- `web/index.html` — `#timeframeSel`'s `<option>` list updated.

## Testing

Matching the project's established split for this feature area:

- `seedBars` is a pure function addition to `web/lib/metrics.js` — gets a
  real `node:assert` unit test in `test/web.metrics.test.js` (same file
  the foundation plan's other `metrics.js` tests live in): seeding
  populates the bar array, respects the `maxBars` cap, and a subsequent
  `addTick` whose bucket matches the last seeded bar's `t` extends it
  rather than creating a duplicate.
- The exchange connectors' `fetchKlines` gaining `t`/`o` fields is also
  testable: each connector's existing informal contract (verified via the
  mock connector, matching the pattern `test/server.candles.test.js`
  already established) gets a small assertion that returned candles
  include numeric `t` and `o` fields.
- Wall overlay rendering and the fetch-on-visible/fetch-on-timeframe-change
  UI wiring are canvas/DOM work with no automated test coverage, per this
  project's established non-goal for that category — verified manually via
  real headless-browser testing (the same `playwright-core` +
  cached-Chromium approach used throughout the UI wiring plan), not by
  automated tests.

## Open Items for the Implementation Plan

- Exact wall-line visual styling (box padding/font size) — reasonable
  defaults proposed, confirm/tune during implementation against a real
  screenshot comparison.
- Whether `limit=200` for seeded history is the right default across all
  seven timeframes (e.g. 200×1d candles is ~6.5 months of daily history,
  arguably more than needed, while 200×1m is under 3.5 hours) — may want a
  timeframe-dependent limit; confirm at plan time.
