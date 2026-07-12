import { natr, avgRange } from "./metrics.js";

/** Periodically refresh NATR(5m/14) and Range(1m/5) for the top-N coins, using each coin's best source. */
export function startKlineLoop(market, connectors, cfg, onCycle) {
  let running = false;

  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      const top = market.top(cfg.topKlines);
      let i = 0;
      const worker = async () => {
        while (i < top.length) {
          const c = top[i++];
          const conn = connectors[c.best];
          const sym = c.sources[c.best]?.sym;
          if (!conn?.fetchKlines || !sym) continue;
          try {
            const [k5, k1] = await Promise.all([
              conn.fetchKlines(sym, "5m", 15),
              conn.fetchKlines(sym, "1m", 5)
            ]);
            c.natr = natr(k5);
            c.range = avgRange(k1);
          } catch { /* rate limit / delisted symbol — skip */ }
        }
      };
      await Promise.all(Array.from({ length: cfg.klineConcurrency }, worker));
      onCycle?.(Date.now());
    } finally {
      running = false;
    }
  };

  setTimeout(cycle, 3000);
  const timer = setInterval(cycle, cfg.klineIntervalMs);
  return { cycle, stop: () => clearInterval(timer) };
}
