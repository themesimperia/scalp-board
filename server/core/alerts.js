import fs from "node:fs";
import path from "node:path";

/**
 * Three alert types, mirroring the reference product:
 *  - price   : user-defined level crossed (persisted to data/alerts.json)
 *  - impulse : |move| >= impulsePct within impulseWindowMs (with per-coin cooldown)
 *  - listing : a base asset appears on an exchange for the first time (after warmup)
 */
export class AlertEngine {
  constructor(cfg, market, notify) {
    this.cfg = cfg;
    this.market = market;
    this.notify = notify;               // ({kind, sym, msg, ts}) => void
    this.price = new Map();             // base -> [{level, side}]
    this.cool = new Map();              // base -> cooldown-until ts
    this.file = path.join("data", "alerts.json");
    this.load();
  }

  load() {
    try { this.price = new Map(JSON.parse(fs.readFileSync(this.file, "utf8"))); } catch {}
  }
  save() {
    try {
      fs.mkdirSync("data", { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify([...this.price]));
    } catch {}
  }

  add(base, level) {
    if (!(level > 0)) return false;
    const coin = this.market.coins.get(base);
    const last = coin?.last ?? level;
    const arr = this.price.get(base) || [];
    if (arr.some(a => a.level === level)) return false;
    arr.push({ level, side: level >= last ? "above" : "below" });
    this.price.set(base, arr);
    this.save();
    return true;
  }

  del(base, level) {
    const arr = this.price.get(base);
    if (!arr) return;
    const rest = arr.filter(a => a.level !== level);
    rest.length ? this.price.set(base, rest) : this.price.delete(base);
    this.save();
  }

  list() {
    return [...this.price.entries()].flatMap(([sym, arr]) =>
      arr.map(a => ({ sym, level: a.level, side: a.side })));
  }

  fire(kind, sym, msg) {
    this.notify({ kind, sym, msg, ts: Date.now() });
  }

  /** Called on every ticker update for a coin. */
  onTick(coin) {
    // price levels
    const arr = this.price.get(coin.base);
    if (arr?.length) {
      const rest = arr.filter(a => {
        const hit = a.side === "above" ? coin.last >= a.level : coin.last <= a.level;
        if (hit) this.fire("price", coin.base, `${coin.base} crossed ${a.level} — now ${coin.last}`);
        return !hit;
      });
      if (rest.length !== arr.length) {
        rest.length ? this.price.set(coin.base, rest) : this.price.delete(coin.base);
        this.save();
      }
    }

    // impulse
    const p0 = this.market.priceAgo(coin, this.cfg.impulseWindowMs);
    if (p0 > 0) {
      const d = (coin.last - p0) / p0 * 100;
      if (Math.abs(d) >= this.cfg.impulsePct) {
        const until = this.cool.get(coin.base) || 0;
        if (Date.now() > until) {
          this.cool.set(coin.base, Date.now() + this.cfg.impulseCooldownMs);
          this.fire("impulse", coin.base,
            `${coin.base} ${d > 0 ? "+" : ""}${d.toFixed(1)}% in ${Math.round(this.cfg.impulseWindowMs / 1000)}s (${coin.last})`);
        }
      }
    }
  }

  onListing(coin, source) {
    this.fire("listing", coin.base, `New listing: ${coin.base} on ${source}`);
  }
}
