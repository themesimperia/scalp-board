import { detectWalls } from "./metrics.js";

/**
 * Periodically pulls order books for the top-N coins from EVERY exchange listing them,
 * runs wall detection, and publishes the merged result.
 */
export function startDensityLoop(market, connectors, cfg, onWalls) {
  let walls = [];
  let running = false;

  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      const top = market.top(cfg.densityTop);
      const jobs = [];
      for (const c of top) {
        for (const [src, info] of Object.entries(c.sources)) {
          if (connectors[src]?.fetchDepth) jobs.push({ c, src, sym: info.sym });
        }
      }
      const found = [];
      let i = 0;
      const worker = async () => {
        while (i < jobs.length) {
          const { c, src, sym } = jobs[i++];
          try {
            const ob = await connectors[src].fetchDepth(sym);
            found.push(...detectWalls({ ...ob, last: c.last, ex: src, sym: c.base }, cfg));
          } catch { /* skip */ }
        }
      };
      await Promise.all(Array.from({ length: cfg.densityConcurrency }, worker));
      found.sort((a, b) => b.usd - a.usd);
      walls = found.slice(0, 200);
      onWalls?.(walls);
    } finally {
      running = false;
    }
  };

  setTimeout(cycle, 6000);
  const timer = setInterval(cycle, cfg.densityIntervalMs);
  return { get walls() { return walls; }, cycle, stop: () => clearInterval(timer) };
}
