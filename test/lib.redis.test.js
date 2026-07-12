import assert from "node:assert";
import RedisMock from "ioredis-mock";
import { createRedisClient } from "../server/lib/redis.js";
import { CHANNELS } from "../server/lib/channels.js";

const client = createRedisClient("redis://localhost:6379", RedisMock);

const received = [];
await new Promise((resolve) => {
  client.subscribe(CHANNELS.ticks("binance"), payload => {
    received.push(payload);
    resolve();
  });
  // subscribe is async under the hood (ioredis SUBSCRIBE round-trip); wait a tick before publishing
  setTimeout(() => client.publish(CHANNELS.ticks("binance"), { base: "BTC", last: 68000 }), 20);
});

assert.strictEqual(received.length, 1);
assert.deepStrictEqual(received[0], { base: "BTC", last: 68000 });

// unsubscribe stops delivery
let afterUnsub = false;
const handler = () => { afterUnsub = true; };
client.subscribe(CHANNELS.snap, handler);
client.unsubscribe(CHANNELS.snap, handler);
client.publish(CHANNELS.snap, { coins: [] });
await new Promise(r => setTimeout(r, 20));
assert.strictEqual(afterUnsub, false, "handler must not fire after unsubscribe");

await client.quit();
console.log("redis wrapper tests passed ✔");
