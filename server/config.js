export const CFG = {
  port: +(process.env.PORT || 8080),
  mock: process.env.MOCK === "1",

  // Metrics (klines)
  topKlines: +(process.env.TOP_KLINES || 120),   // compute NATR/range for top-N coins by volume
  klineIntervalMs: 60_000,
  klineConcurrency: 4,

  // Density map (order book walls)
  densityTop: +(process.env.DENSITY_TOP || 30),  // scan order books of top-N coins
  densityIntervalMs: +(process.env.DENSITY_MS || 20_000),
  densityConcurrency: 3,
  wallMinUsd: +(process.env.WALL_MIN_USD || 200_000),
  wallMaxDistPct: +(process.env.WALL_MAX_DIST || 3),
  wallDominance: +(process.env.WALL_DOMINANCE || 8), // wall must be >= 8x median level size

  // Alerts
  impulsePct: +(process.env.IMPULSE_PCT || 3),   // % move within window triggers impulse alert
  impulseWindowMs: 60_000,
  impulseCooldownMs: 5 * 60_000,
  listingWarmupMs: 90_000,                        // ignore "new symbols" during startup

  // Telegram (optional)
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChat: process.env.TELEGRAM_CHAT_ID || ""
};
