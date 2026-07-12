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
