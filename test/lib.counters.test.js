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
