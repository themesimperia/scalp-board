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

// unsubscribe targets only the specific handler, not the whole channel:
// two handlers on the same channel, unsubscribe one, the other must keep receiving
{
  const channel = "test:multi-handler";
  const receivedA = [];
  const receivedB = [];
  const handlerA = payload => receivedA.push(payload);
  const handlerB = payload => receivedB.push(payload);

  await new Promise((resolve) => {
    client.subscribe(channel, handlerA);
    client.subscribe(channel, handlerB);
    setTimeout(resolve, 20);
  });

  client.unsubscribe(channel, handlerA);
  client.publish(channel, { tick: 1 });
  await new Promise(r => setTimeout(r, 20));

  assert.strictEqual(receivedA.length, 0, "unsubscribed handler must not receive further messages");
  assert.strictEqual(receivedB.length, 1, "sibling handler on the same channel must still receive messages");
  assert.deepStrictEqual(receivedB[0], { tick: 1 });
}

// malformed / non-JSON payloads are dropped silently, not delivered, not thrown
{
  const channel = "test:malformed";
  const received = [];
  const handler2 = payload => received.push(payload);

  await new Promise((resolve) => {
    client.subscribe(channel, handler2);
    setTimeout(resolve, 20);
  });

  // publish raw (non-JSON-encoded) bytes directly on the underlying shared mock bus,
  // bypassing the wrapper's own publish() which always JSON.stringifies its input
  const rawClient = new RedisMock("redis://localhost:6379");
  rawClient.publish(channel, "not-json{{{");
  await new Promise(r => setTimeout(r, 20));

  assert.strictEqual(received.length, 0, "malformed payload must be dropped silently, never delivered to handlers");
}

// a throwing handler must not stop sibling handlers on the same channel from
// receiving the message, and must not crash the process (regression test for
// the unhandled-exception-in-message-listener fix)
{
  const channel = "test:handler-throws";
  const receivedBySurvivor = [];
  const throwingHandler = () => { throw new Error("boom - intentional handler failure for test"); };
  const survivingHandler = payload => receivedBySurvivor.push(payload);

  await new Promise((resolve) => {
    // register the throwing handler first so a broken fix (bail out of the
    // dispatch loop on first exception) would be caught by this test
    client.subscribe(channel, throwingHandler);
    client.subscribe(channel, survivingHandler);
    setTimeout(resolve, 20);
  });

  client.publish(channel, { alert: "test" });
  await new Promise(r => setTimeout(r, 20));

  assert.strictEqual(receivedBySurvivor.length, 1, "a throwing handler must not prevent sibling handlers from receiving the message");
  assert.deepStrictEqual(receivedBySurvivor[0], { alert: "test" });
}

await client.quit();
console.log("redis wrapper tests passed ✔");
