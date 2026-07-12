import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { CFG } from "./config.js";
import { Market } from "./core/market.js";
import { startKlineLoop } from "./core/klines.js";
import { startDensityLoop } from "./core/density.js";
import { AlertEngine } from "./core/alerts.js";
import { createCandleCache, createCandleHandler } from "./core/candleApi.js";
import { makeTelegram } from "./telegram.js";

import * as binance from "./exchanges/binance.js";
import * as bybit from "./exchanges/bybit.js";
import * as okx from "./exchanges/okx.js";
import * as mock from "./exchanges/mock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, "..", "web");

/* ---------- wiring ---------- */
const market = new Market();
market.listingWarmupMs = CFG.listingWarmupMs;

const connectors = CFG.mock
  ? { mock }
  : { binance, bybit, okx };

const status = {};            // exchange -> "live" | "down"
const telegram = makeTelegram(CFG);
let lastKlineTs = 0;
let latestWalls = [];
const recentAlerts = [];      // ring buffer for late joiners

const engine = new AlertEngine(CFG, market, evt => {
  recentAlerts.push(evt);
  if (recentAlerts.length > 50) recentAlerts.shift();
  broadcast({ t: "alert", ...evt });
  telegram?.(`⚡ ${evt.msg}`);
  console.log(`[alert:${evt.kind}] ${evt.msg}`);
});
market.onListing = (coin, src) => engine.onListing(coin, src);

const candleCache = createCandleCache(45_000);
const candleHandler = createCandleHandler(market, connectors, candleCache);

const onTicker = (src, t) => {
  const coin = market.upsert(src, t);
  if (coin) engine.onTick(coin);
};
const onStatus = (src, st) => {
  if (status[src] !== st) console.log(`[${src}] ${st}`);
  status[src] = st;
};

for (const conn of Object.values(connectors)) conn.startTickers(onTicker, onStatus);
startKlineLoop(market, connectors, CFG, ts => { lastKlineTs = ts; });
startDensityLoop(market, connectors, CFG, walls => {
  latestWalls = walls;
  broadcast({ t: "density", walls });
});

/* ---------- http: static files + JSON snapshot ---------- */
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/snapshot") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ coins: market.snapshot(), walls: latestWalls, status, ts: Date.now() }));
    return;
  }
  if (u.pathname === "/api/candles") {
    candleHandler(req, res);
    return;
  }
  let file = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const fp = path.join(WEB_DIR, file);
  if (!fp.startsWith(WEB_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(data);
  });
});

/* ---------- websocket: push snapshots, density, alerts ---------- */
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}

wss.on("connection", ws => {
  ws.send(JSON.stringify({ t: "hello", alerts: engine.list(), walls: latestWalls, recent: recentAlerts, status }));
  ws.on("message", buf => {
    let m; try { m = JSON.parse(buf); } catch { return; }
    if (m.t === "alert:add" && typeof m.sym === "string" && m.sym.length <= 20) {
      if (engine.add(m.sym.toUpperCase(), +m.level)) {
        broadcast({ t: "alerts", list: engine.list() });
      }
    } else if (m.t === "alert:del") {
      engine.del(String(m.sym).toUpperCase(), +m.level);
      broadcast({ t: "alerts", list: engine.list() });
    }
  });
});

setInterval(() => {
  if (!wss.clients.size) return;
  broadcast({ t: "snap", coins: market.snapshot(), status, klineTs: lastKlineTs, ts: Date.now() });
}, 1000);

server.listen(CFG.port, () => {
  console.log(`tapeboard ${CFG.mock ? "(MOCK MODE) " : ""}listening on http://localhost:${CFG.port}`);
  console.log(`exchanges: ${Object.keys(connectors).join(", ")}`);
  if (!telegram) console.log("telegram: disabled (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to enable)");
});
