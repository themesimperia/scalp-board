# TapeBoard

A multi-exchange crypto scalping screener — unified feed across **Binance, Bybit and OKX** (USDT perps), with server-computed volatility metrics, an order-book **density map**, and an alert engine (price levels, impulse spikes, new listings) with optional **Telegram** delivery.

## Quick start

```bash
npm install
npm start            # live mode — connects to Binance + Bybit + OKX public APIs
# open http://localhost:8080
```

No API keys needed — all market data endpoints are public.

Test everything offline with simulated data (fake tickers, candles, walls, impulses):

```bash
npm run mock
```

Run unit tests:

```bash
npm test
```

## Telegram alerts

1. Create a bot with **@BotFather**, copy the token.
2. Send your bot any message, then get your numeric chat id (e.g. via **@userinfobot**).
3. Start with:

```bash
TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_CHAT_ID=99999999 npm start
```

Every alert (price cross, impulse, listing) is pushed to your Telegram — this works even when no browser tab is open, because the server holds the exchange connections 24/7.

## What's inside

| Feature | How it works |
|---|---|
| Unified coin list | Coins keyed by base asset; each exchange listing tracked; **highest 24h volume source wins** (BI-F / BY-F / OK-F tag shows which). No duplicates. |
| Live prices | Binance: one WebSocket stream for all perps. Bybit/OKX: all-market REST poll every 3s (their WS requires per-symbol subs). |
| NATR 5m/14 & Range 1m/5 | Server fetches real klines from each coin's best source every 60s for the top 120 coins. |
| Density map | Order books of the top 30 coins pulled from **every** exchange listing them, every 20s. A wall = level within 3% of price, ≥ $200K notional, and ≥ 8× the median level size. OKX contract sizes are converted to base units via `ctVal`. |
| Alerts | Price levels (persisted to `data/alerts.json`, survive restarts), impulse (≥3% in 60s, 5-min cooldown per coin), new-listing detection (after a 90s warmup). Delivered to all web clients + Telegram. |
| Watchlist | Client-side (localStorage), star any coin, toggle the ★ filter. |

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | HTTP/WS port |
| `MOCK` | — | `1` = simulated exchange, zero network |
| `TOP_KLINES` | 120 | coins to compute NATR/range for |
| `DENSITY_TOP` | 30 | coins to scan order books for |
| `DENSITY_MS` | 20000 | density scan period |
| `WALL_MIN_USD` | 200000 | minimum wall notional |
| `WALL_MAX_DIST` | 3 | max distance from price, % |
| `WALL_DOMINANCE` | 8 | wall ≥ N× median level size |
| `IMPULSE_PCT` | 3 | impulse alert threshold, % per 60s |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | enable Telegram delivery |

## Architecture

```
server/
  index.js            HTTP + WebSocket server, wiring, broadcast loop (1 snap/s)
  config.js           env-driven settings
  exchanges/
    binance.js        WS tickers + REST klines/depth
    bybit.js          REST tickers/klines/depth
    okx.js            REST tickers/klines/depth (+ ctVal contract conversion)
    mock.js           simulated exchange for offline dev
  core/
    market.js         unified registry, dedup, best-source, price history
    metrics.js        pure functions: NATR, range, wall detection (unit-tested)
    klines.js         metric refresh scheduler
    density.js        order-book scan scheduler
    alerts.js         alert engine + persistence
  telegram.js         optional Bot API notifier
web/
  index.html          the app (screener / density / alerts, watchlist)
test/
  metrics.test.js
```

## Deployment

This needs a long-running process (persistent WebSocket to Binance), so use a small VPS — a $5/mo box is plenty:

```bash
npm i -g pm2
pm2 start server/index.js --name tapeboard
pm2 save && pm2 startup
```

Put nginx/Caddy in front for TLS. Serverless platforms (Vercel functions) won't fit the aggregator itself, but you can host a static landing page there and point it at the VPS.

## Roadmap to a full product

- [ ] User accounts (Telegram Login Widget fits the niche) + per-user alerts
- [ ] Billing (Stripe subscriptions or crypto payments)
- [ ] Candle history persistence + cross-exchange backfill (store to SQLite/Postgres)
- [ ] Per-symbol WS depth streams for faster density refresh
- [ ] Spot markets alongside perps
- [ ] Landing page

## Notes

- Public-endpoint rate limits are respected by design (bounded concurrency, all-market endpoints). If you raise `TOP_KLINES`/`DENSITY_TOP` a lot, watch for 429s.
- This is a trading *information* tool; nothing here is investment advice.
