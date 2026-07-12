// Simulated exchange so the whole stack (UI, metrics, density, alerts) runs with zero network.
export const name = "mock";

const BASES = [
  ["BTC", 68000, 18e9], ["ETH", 3600, 8e9], ["SOL", 190, 3e9], ["XRP", 1.9, 2e9],
  ["DOGE", 0.31, 1.4e9], ["PEPE", 0.000021, 900e6], ["TON", 6.4, 640e6], ["AVAX", 42, 500e6],
  ["LINK", 19, 420e6], ["BNB", 640, 380e6], ["ARB", 1.1, 300e6], ["OP", 2.4, 260e6],
  ["SUI", 3.9, 240e6], ["APT", 11, 210e6], ["WIF", 2.8, 180e6], ["LTC", 92, 160e6],
  ["ADA", 0.71, 140e6], ["DOT", 8.2, 120e6], ["NEAR", 6.1, 110e6], ["INJ", 27, 90e6],
  ["SIREN", 0.14, 428e6], ["PIPPIN", 0.05, 644e6], ["ZEC", 45, 961e6]
];

const state = new Map();
for (const [base, px, vol] of BASES) {
  state.set(base, { px, open: px, vol, trades: Math.round(vol / 8000) });
}

function step(s) {
  // occasional impulse to exercise the alert engine
  const shock = Math.random() < 0.002 ? (Math.random() - 0.5) * 0.06 : 0;
  s.px *= 1 + (Math.random() - 0.5) * 0.0025 + shock;
}

export function startTickers(onTicker, onStatus, intervalMs = 900) {
  onStatus?.(name, "live");
  setInterval(() => {
    for (const [base, s] of state) {
      step(s);
      onTicker(name, {
        base, sym: base + "USDT", last: s.px,
        chg: (s.px - s.open) / s.open * 100,
        vol: s.vol * (0.98 + Math.random() * 0.04),
        trades: s.trades
      });
    }
  }, intervalMs);
}

export async function fetchKlines(sym, interval, limit) {
  const s = state.get(sym.replace("USDT", ""));
  const px = s ? s.px : 100;
  const volPct = interval === "1m" ? 0.004 : 0.009;
  const out = [];
  let c = px;
  for (let i = 0; i < limit; i++) {
    const o = c;
    c = o * (1 + (Math.random() - 0.5) * volPct);
    const h = Math.max(o, c) * (1 + Math.random() * volPct * 0.6);
    const l = Math.min(o, c) * (1 - Math.random() * volPct * 0.6);
    out.push({ h, l, c });
  }
  return out;
}

export async function fetchDepth(sym) {
  const s = state.get(sym.replace("USDT", ""));
  const px = s ? s.px : 100;
  const mk = side => {
    const lvls = [];
    for (let i = 1; i <= 120; i++) {
      const p = px * (1 + (side === "ask" ? 1 : -1) * i * 0.0003);
      let usd = 3000 + Math.random() * 25_000;
      if (Math.random() < 0.02) usd = 250_000 + Math.random() * 4_000_000; // plant walls
      lvls.push([p, usd / p]);
    }
    return lvls;
  };
  return { bids: mk("bid"), asks: mk("ask") };
}
