import assert from "node:assert";
import { createBarAggregator, natr, avgRange, selectCoins, paginate, pageCount, findTrendLine, findTrendLines } from "../web/lib/metrics.js";

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

  // missing sort-key values always sort last, regardless of sortDir
  const withMissing = [
    { s: "A", v: 1e9, c: 1.5 },
    { s: "B", v: 1e9 }, // missing .c
    { s: "C", v: 1e9, c: -2 }
  ];
  out = selectCoins(withMissing, { sortKey: "c", sortDir: 1 });
  assert.deepStrictEqual(out.map(c => c.s), ["C", "A", "B"], "ascending: missing value (B) sorts last");

  out = selectCoins(withMissing, { sortKey: "c", sortDir: -1 });
  assert.deepStrictEqual(out.map(c => c.s), ["A", "C", "B"], "descending: missing value (B) still sorts last");
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

// --- findTrendLine: non-array input returns null instead of throwing ---
{
  assert.strictEqual(findTrendLine(undefined, "low"), null, "undefined bars -> null");
  assert.strictEqual(findTrendLine(null, "low"), null, "null bars -> null");
}

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

// --- addTick: clock-skew tick (bucket <= last bar's t) folds into the last bar instead of appending out of order ---
{
  const agg = createBarAggregator(60_000);
  agg.addTick("BTC", 1_000, 100);
  agg.addTick("BTC", 65_000, 110); // opens bar at t=60_000
  agg.addTick("BTC", 125_000, 120); // opens bar at t=120_000
  let bars = agg.getBars("BTC");
  assert.strictEqual(bars.length, 3, "sanity: three bars established so far");
  const barsBefore = bars.map(b => ({ ...b }));

  // simulate clock skew: a tick whose bucket computes to BEFORE the last bar's t
  agg.addTick("BTC", 61_000, 5); // floor(61000/60000)*60000 = 60_000, which is < last bar's t (120_000)
  bars = agg.getBars("BTC");

  assert.strictEqual(bars.length, 3, "no new bar appended for a chronologically-earlier tick");
  const last = bars[bars.length - 1];
  assert.strictEqual(last.t, barsBefore[2].t, "last bar's timestamp unchanged");
  assert.strictEqual(last.h, Math.max(barsBefore[2].h, 5), "high folded in (unchanged here since 5 < previous high)");
  assert.strictEqual(last.l, 5, "low updated to reflect the out-of-order tick's price");
  assert.strictEqual(last.c, 5, "close updated to reflect the out-of-order tick's price (folded in, not discarded)");
  for (let i = 0; i < bars.length; i++) {
    assert.strictEqual(bars[i].t, barsBefore[i].t, "bar order/timestamps unchanged for all other bars");
  }
  for (let i = 1; i < bars.length; i++) {
    assert.ok(bars[i].t >= bars[i - 1].t, "bars array remains monotonically non-decreasing in t");
  }
}

console.log("web metrics (bar aggregation) tests passed ✔");
