import Redis from "ioredis";

export function createRedisClient(url, RedisImpl = Redis) {
  const pub = new RedisImpl(url);
  const sub = new RedisImpl(url);
  const handlers = new Map(); // channel -> Set<fn>

  sub.on("message", (channel, message) => {
    const set = handlers.get(channel);
    if (!set || !set.size) return;
    let payload;
    try { payload = JSON.parse(message); } catch { return; }
    for (const fn of set) {
      try { fn(payload); } catch { /* swallow — a broken consumer must not take down message delivery for everyone else */ }
    }
  });

  return {
    publish(channel, obj) {
      return pub.publish(channel, JSON.stringify(obj));
    },
    subscribe(channel, handler) {
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
        sub.subscribe(channel).catch(() => {});
      }
      set.add(handler);
    },
    unsubscribe(channel, handler) {
      const set = handlers.get(channel);
      if (!set) return;
      set.delete(handler);
      if (!set.size) {
        handlers.delete(channel);
        sub.unsubscribe(channel).catch(() => {});
      }
    },
    quit() {
      return Promise.all([pub.quit(), sub.quit()]);
    }
  };
}
