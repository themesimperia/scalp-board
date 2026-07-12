# TapeBoard Engine Hardening — Multi-Service Architecture

**Date:** 2026-07-12
**Phase:** 1 of 3 (engine hardening → UI redesign → productization)
**Status:** Approved for planning

## Context

TapeBoard is a working multi-exchange crypto scalping screener (Binance/Bybit/OKX perps),
originally inspired by scalpboard.io, currently running as a single Node process:

- Binance tickers arrive over one WebSocket (real-time, already has reconnect+backoff).
- Bybit and OKX tickers are REST-polled every 3s; their order books (density/wall
  detection) are REST-polled every 20s. This is the main latency bottleneck.
- All state (coin registry, price history, computed NATR/range, density) lives in
  memory; only price alerts persist to `data/alerts.json`. A restart loses everything
  else and metrics stay blank until the first kline cycle completes.
- Errors from exchange calls are silently swallowed (`catch { /* skip */ }`); there's
  no visibility into rate-limiting, stalled connections, or reconnect activity beyond
  console logs.
- Single process, single VPS ($5/mo), no independent scaling of the client-facing
  layer from data ingestion.

The project owner expects real user traffic soon and wants the engine to be faster,
persistent across restarts, observable, and resilient — before layering a new UI and
then productization (accounts/billing/deploy) on top in later phases.

This document specs **phase 1 only**: the engine hardening/speed rework. It does not
cover UI redesign or productization; those get their own specs once this phase ships.

## Goals

1. Eliminate REST-polling latency for Bybit/OKX tickers and order books — replace
   with WebSocket push, matching Binance's real-time behavior.
2. Survive restarts without losing history: candle data (with real backfill/retention,
   not just a NATR/range working set), alerts, and recent alert history persist.
3. Make failures visible: structured logs, health endpoints, staleness detection —
   no more silent `catch { skip }` black holes.
4. Support horizontal scaling of the client-facing layer ahead of anticipated traffic
   growth, without over-building for scale that isn't needed yet.

## Non-goals (deferred to later phases)

- UI/visual redesign (phase 2).
- User accounts, billing, landing page, hosting productization (phase 3).
- Full historical backfill/charting UI (the data foundation is laid here, the
  feature itself is not).
- Kubernetes or multi-region deployment (Docker Compose is sufficient for this phase).

## Architecture

Six deployable units, integrated only through Redis pub/sub — no service needs to
know another service's network address, only Redis's:

- **`ingestion-binance`**, **`ingestion-bybit`**, **`ingestion-okx`** — one per
  exchange, fully independent processes/containers. Each owns that exchange's
  connector: Binance keeps its all-market ticker WS; Bybit and OKX move from REST
  polling to multiplexed WebSocket subscriptions for both tickers and order books
  (chunked subscribe messages respecting each exchange's per-request limits,
  ping/pong keepalive, exponential backoff+jitter reconnect matching the existing
  Binance pattern). Order books are maintained as local L2 state via snapshot+delta
  merge with checksum-triggered resync. Klines/candles stay REST-polled (60s cadence
  is adequate; no need for push here). Each service publishes normalized events to
  Redis and does NOT stream full order books continuously — see Data Flow below for
  the on-demand depth subscription control.
- **`aggregator`** (singleton — the one source of truth for market state) —
  subscribes to all ingestion events, runs the existing `Market` registry logic
  (dedup, best-source selection, NATR/range computation, wall detection, alert
  engine), owns the SQLite database (sole writer), and republishes consolidated
  snapshot/density/alert events to Redis for gateways to consume. Also owns the
  depth-subscription control loop (tells ingestion services which symbols to stream
  order books for, based on the current top-N by volume).
- **`gateway`** (horizontally scalable, N replicas) — holds client WebSocket
  connections, serves static web assets and the `/api/snapshot` REST endpoint.
  Subscribes to Redis for `snap`/`density`/`alerts` broadcasts and maintains an
  in-memory read-replica mirror, structurally identical to what today's single
  process already builds from its in-process `Market` object — this code changes
  the least. Forwards client alert add/delete actions to the aggregator via a Redis
  command channel (`cmd:alerts`), never touches SQLite directly. Because every
  replica's state is purely a mirror of Redis broadcasts, **no sticky sessions are
  needed** — any client can connect to any replica.
- **`telegram-notifier`** — small standalone consumer of the alert event stream,
  isolated so a Telegram API outage can't affect core data flow.

## Data Flow

Ingestion services publish to exchange-scoped channels: `ticks:binance`,
`ticks:bybit`, `ticks:okx`, `klines:<exchange>`, and `depth:<exchange>:<symbol>`
(only for actively-subscribed symbols — see below).

The aggregator subscribes to all `ticks:*` and active `depth:*` channels, runs the
unified market logic, and republishes three consolidated channels:

- **`snap`** — 1/sec coin snapshot, same shape as today's WS `snap` message.
- **`density`** — wall/density updates.
- **`alerts`** — alert events and list changes (including the results of
  `cmd:alerts` mutations — gateways get an optimistic-UI-then-confirm-via-broadcast
  flow, same pattern the app already uses today).

**Depth subscription control:** rather than streaming full order books through Redis
continuously (bandwidth-heavy) or having gateways/aggregator poll REST, the
aggregator sends `subscribe:<symbol>` / `unsubscribe:<symbol>` control messages to
the relevant `ingestion-<exchange>` service's command channel as its top-N-by-volume
set changes. That service starts/stops streaming depth deltas for just those
symbols in response. This keeps WS subscription counts bounded to what's actually
needed for the density scan.

## Persistence

SQLite, owned exclusively by the aggregator (single writer, no cross-process
contention to manage):

- **`candles`** (exchange, symbol, interval, open_time, o/h/l/c, volume) — retains
  real history per a configurable retention window per interval:
  `CANDLE_RETENTION_1M_DAYS` (default 3) and `CANDLE_RETENTION_5M_DAYS` (default 30).
  This is real backfill data (foundation for a future charting feature), not just
  the NATR(14)/Range(5) working set. A pruning pass runs alongside the kline cycle,
  deleting rows older than the configured window.
  - Rough sizing: ~300 symbols × 3 days × 1440 (1m/day) ≈ 1.3M rows, plus
    ~300 × 30 days × 288 (5m/day) ≈ 2.6M rows — a few hundred MB, comfortable for a
    small VPS, and both windows are env-configurable.
- **`alerts`** — replaces `data/alerts.json` with equivalent data/semantics.
- **`alert_history`** — persists the "recent alerts" ring buffer (currently
  in-memory only, capped ~50) so late-joining clients see recent activity even
  after a restart.

On aggregator startup: hydrate NATR/range from `candles` immediately (no more blank
metrics until the first 60s kline cycle completes); for any symbol with insufficient
history (new listing, first run), do a bounded one-time REST backfill via the
exchange's existing `fetchKlines` up to the retention window. Reload `alerts` into
the alert engine and `alert_history` into the ring buffer. All writes are batched
per kline-cycle/alert-event (not per-tick) to stay off the hot path.

## Observability

- **Structured logging via `pino`** — every service logs JSON lines (service name,
  level, timestamp, exchange/symbol context) instead of ad hoc `console.log`,
  making logs greppable/aggregable across 6 processes instead of 1.
- **`/health` endpoint per service** — process uptime, per-exchange/channel
  last-event timestamp, reconnect counts, error counts, and (gateway only) connected
  client count. Catches the failure mode current code misses entirely: a WebSocket
  that's technically open but has stopped receiving messages (today's `status` only
  flips on actual `close`/`error`, not silent stalls).
- **Staleness detection** — the aggregator tracks last-tick-received-per-exchange
  and flips status to `"stale"` (a new state alongside `"live"`/`"down"`) if nothing
  arrives for >15s, feeding both UI status badges and Telegram so degradation is
  visible instead of silently frozen data.
- **Metrics counters** exposed on `/health`: messages/sec per exchange, depth resync
  counts, Redis pub/sub lag, WS client count per gateway replica. No separate
  Prometheus stack for this phase — that's more infra than currently needed.

## Error Handling & Resilience

- **WS reconnect** — the existing Binance-style exponential backoff+jitter pattern
  extends to the new Bybit/OKX ticker and depth WebSocket connections, and to every
  service's Redis client.
- **Circuit breaker on REST** — kline fetches and depth backfill back off
  progressively on repeated failure instead of retrying on a fixed interval, so a
  rate-limited or degraded exchange doesn't get hammered further.
- **Depth resync** — an order-book checksum mismatch (both Bybit and OKX provide
  one) triggers a full REST re-snapshot + resubscribe for just that symbol, not a
  service restart.
- **Graceful multi-source degradation** — if `ingestion-okx` goes down entirely, the
  aggregator keeps functioning off Binance/Bybit data for coins listed there (best-
  source logic already supports this today); the outage surfaces via `/health` and
  status badges rather than being masked.
- **Gateway backpressure** — `ws.send()` currently fires without checking if a
  client is slow to drain, which can silently balloon memory per stuck connection
  under real traffic. Add a `bufferedAmount` check and disconnect clients that fall
  too far behind rather than buffering indefinitely.
- **Process supervision** — all six services run under pm2 (already used today)
  with auto-restart; README gets updated deployment instructions for the full
  fleet instead of a single process.

## Deployment Topology

Docker Compose — real service isolation and independent scaling without jumping to
Kubernetes-level complexity for a still-modest deployment:

- One `docker-compose.yml` defines `ingestion-binance`, `ingestion-bybit`,
  `ingestion-okx`, `aggregator`, `gateway`, `telegram-notifier`. Each is the same
  codebase/image with a different entrypoint/env var — one `Dockerfile`, not six
  images to maintain.
- **`gateway` is the one service you scale**: `docker-compose up --scale gateway=3`.
  Because every replica hydrates state purely from Redis pub/sub, no sticky
  sessions are needed. A reverse proxy (Caddy, for near-zero-config TLS) load
  balances across replicas and terminates TLS.
- **Redis is managed from day 1** (e.g. Upstash), not self-hosted — all services
  connect via `REDIS_URL`. Since Redis is a relay, not the source of truth (SQLite
  in the aggregator is), a brief Redis interruption loses no data, just pauses the
  pub/sub relay until services reconnect.
- Runs on one moderately larger VPS than the current $5/mo box (now running ~6
  containers instead of 1 process), or can be split across hosts later without any
  application code changes — the service boundaries already allow it.

## Testing Plan

- **Unit tests** stay in the current lean style (`node:assert`, no framework) —
  `metrics.test.js` untouched. New pure-logic modules (order-book snapshot+delta
  merge/checksum verification, the reconnect/backoff scheduler) get the same
  treatment, testable with fake timers, no real sockets needed.
- **Cross-service integration tests** use `ioredis-mock` (in-memory, no real Redis
  needed) so the `ingestion → aggregator → gateway` flow is testable deterministically
  and fast in CI, feeding synthetic ticks/depth through the existing `mock.js`
  exchange data.
- **Full-stack manual testing** — today's `npm run mock` (single process, zero
  network) becomes `docker-compose.mock.yml`, running all six services in MOCK mode
  against a local ephemeral Redis, so the full running UI can be exercised without
  touching real exchanges or the managed Redis instance.
- **Pre-deploy smoke check** — a short script hitting every service's `/health`
  endpoint, confirming `status: ok` before considering a deploy successful.

## Open Items for the Implementation Plan

- Exact Redis channel message schemas (field names/types) for `ticks:*`, `depth:*`,
  `snap`, `density`, `alerts`, `cmd:alerts`, and the ingestion depth-subscription
  control channel.
- SQLite schema DDL and migration approach (none exists today — this is a fresh
  schema).
- Chunking limits per exchange for WS subscribe messages (Bybit/OKX have documented
  per-connection/per-request symbol limits that determine how many WS connections
  each ingestion service needs internally, if any beyond one).
- Base Docker image and per-service entrypoint/env convention.
