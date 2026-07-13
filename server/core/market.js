// Unified coin registry. Coins are keyed by BASE asset (BTC, ETH, ...) for USDT-quoted perps.
// Each coin tracks every exchange that lists it; the "best" source (highest 24h volume) drives price/vol.

export class Market {
  constructor() {
    this.coins = new Map();      // base -> coin
    this.startTs = Date.now();
    this.onListing = null;       // (coin, source) => void
    this.listingWarmupMs = 90_000;
  }

  /** t: { base, sym, last, chg, vol, trades?, hi24?, lo24? } */
  upsert(source, t) {
    if (!(t.last > 0) || !t.base) return null;
    let c = this.coins.get(t.base);
    const isNew = !c;
    if (isNew) {
      c = {
        base: t.base, sources: {}, best: source,
        last: t.last, prev: t.last, chg: t.chg ?? 0, vol: 0,
        trades: null, hi24: null, lo24: null, natr: null, range: null, hist: []
      };
      this.coins.set(t.base, c);
    }
    c.sources[source] = {
      sym: t.sym, last: t.last, chg: t.chg ?? 0,
      vol: t.vol ?? 0, trades: t.trades ?? null,
      hi24: t.hi24 ?? null, lo24: t.lo24 ?? null, ts: Date.now()
    };

    // pick best source by 24h quote volume
    let best = null;
    for (const [s, v] of Object.entries(c.sources)) {
      if (!best || v.vol > c.sources[best].vol) best = s;
    }
    c.best = best;
    const b = c.sources[best];
    c.prev = c.last;
    c.last = b.last;
    c.chg = b.chg;
    c.vol = b.vol;
    // trade count is only exposed by Binance's API — surface it whenever Binance lists the coin
    c.trades = c.sources.binance?.trades ?? b.trades ?? null;
    c.hi24 = b.hi24;
    c.lo24 = b.lo24;

    // rolling price history (for impulse alerts), pruned to 90s
    const now = Date.now();
    const h = c.hist;
    if (!h.length || now - h[h.length - 1][0] >= 1000) h.push([now, c.last]);
    while (h.length && now - h[0][0] > 90_000) h.shift();

    if (isNew && this.onListing && now - this.startTs > this.listingWarmupMs) {
      this.onListing(c, source);
    }
    return c;
  }

  /** Price approximately `ms` ago (oldest sample inside the window), or null. */
  priceAgo(coin, ms) {
    const cut = Date.now() - ms;
    for (const [ts, p] of coin.hist) if (ts >= cut) return p;
    return null;
  }

  top(n) {
    return [...this.coins.values()].sort((a, b) => b.vol - a.vol).slice(0, n);
  }

  /** Compact snapshot for the wire. */
  snapshot() {
    const out = [];
    for (const c of this.coins.values()) {
      out.push({
        s: c.base,
        x: c.best,
        l: c.last,
        c: +(+c.chg).toFixed(2),
        v: Math.round(c.vol),
        t: c.trades,
        n: c.natr != null ? +c.natr.toFixed(2) : null,
        r: c.range != null ? +c.range.toFixed(2) : null,
        h24: c.hi24 ?? null,
        l24: c.lo24 ?? null
      });
    }
    return out;
  }
}
