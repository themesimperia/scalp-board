import { createBarAggregator, selectCoins, paginate, pageCount, findTrendLines, natr as clientNatr, avgRange as clientAvgRange } from "./lib/metrics.js";
import { drawPanel } from "./lib/chart.js";

const $ = id => document.getElementById(id);
const EX_TAG = { binance:"BI-F", bybit:"BY-F", okx:"OK-F", mock:"SIM" };

let coins = [];                 // latest snapshot
const prevPx = new Map();       // sym -> last price (for flashes)
let armedAlerts = [];           // [{sym, level, side}]
let walls = [];
let sortKey = "v", sortDir = -1, searchQ = "", minVol = 10_000_000, wlOnly = false;
const watch = new Set(JSON.parse(localStorage.getItem("tb.watch") || "[]"));

const TIMEFRAMES = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
let timeframe = "5m";
let aggregator = createBarAggregator(TIMEFRAMES[timeframe]);
let aggregatorGen = 0; // bumped whenever `aggregator` is reassigned, so an in-flight seedHistory fetch can detect staleness
const trendLinesBySym = new Map();   // symbol -> {resistance, support}
const lastBarTsBySym = new Map();    // symbol -> last-seen bar's open ts (to know when a bar closed)
const lastTickAt = new Map();        // symbol -> ts (kept for potential future use; freshness dot uses lastSnapAt below)
let lastSnapAt = 0;                  // ts of the last "snap" WS message received, drives the connection-level freshness dot
let gridDensity = 9;                 // 3 / 6 / 9, Task 7 adds the selector
let gridPage = 0;
let gridPageCount = 1;               // pages in the last renderBoardGrid() pass, so gridNext can wrap without recomputing selectCoins
const panelEls = new Map();          // symbol -> {el, canvas}

let detailSym = null;
let detailTimeframe = null; // null until the first-ever open, which sets it to the CURRENT global `timeframe` at that moment (not at page load) — then persists independently across coins/sessions
let detailAggregator = null;
let detailAggregatorGen = 0;
let detailLastBarTs = null;
let detailTrendLines = null;

/* ---------- formatting ---------- */
function fmtPx(p){ if(p>=1000) return p.toLocaleString("en-US",{maximumFractionDigits:1}); if(p>=1) return p.toLocaleString("en-US",{maximumFractionDigits:4}); return p.toPrecision(4); }
function fmtBig(n){ if(n==null) return "—"; if(n>=1e9) return (n/1e9).toFixed(n>=1e10?0:1)+"B"; if(n>=1e6) return (n/1e6).toFixed(0)+"M"; if(n>=1e3) return (n/1e3).toFixed(0)+"K"; return String(Math.round(n)); }
function fmtTime(ts){ return new Date(ts).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"}); }

/* ---------- websocket ---------- */
let ws;
function connect(){
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = ev => {
    let m; try{ m = JSON.parse(ev.data); }catch{ return; }
    if(m.t === "snap"){
      coins = m.coins; renderStatus(m.status);
      lastSnapAt = Date.now(); // connection/feed-level freshness signal — see renderBoardGrid's stale dot
      $("klAge").textContent = m.klineTs ? Math.round((Date.now()-m.klineTs)/1000)+"s ago" : "loading…";
      renderScreener();
      feedAggregator(coins, Date.now());
      renderBoardGrid(); renderCoinList();
    } else if(m.t === "hello"){
      armedAlerts = m.alerts || []; walls = m.walls || []; renderStatus(m.status);
      renderArmed(); renderDensity(); renderDensityMap();
      for(const a of (m.recent||[]).slice(-15)){
        feedItem(a, false);
        if(a.kind === "listing") renderListings(a);
      }
    } else if(m.t === "density"){
      walls = m.walls || []; renderDensity(); renderDensityMap();
    } else if(m.t === "alerts"){
      armedAlerts = m.list || []; renderArmed(); renderScreener();
    } else if(m.t === "alert"){
      feedItem(m, true);
      if(m.kind === "listing") renderListings(m);
    }
  };
  ws.onclose = () => setTimeout(connect, 2000);
}
connect();

function renderStatus(st){
  if(!st) return;
  $("exStatus").innerHTML = Object.entries(st)
    .map(([ex,s]) => `<span><i class="dot ${s}"></i>${ex}</span>`).join("");
}

/* ---------- screener ---------- */
const rowCache = new Map(); // sym -> {tr, tds, lastVals}
function makeRow(sym){
  const tr = document.createElement("tr");
  tr.innerHTML =
    `<td><span class="star" title="Watchlist">★</span></td>`+
    `<td class="sym">${sym} <span class="tag"></span></td>`+
    `<td></td><td></td><td class="hide-m"></td><td></td>`+
    `<td class="hide-m dim"></td><td></td>`+
    `<td><span class="bell" title="Set price alert">⏰</span></td>`;
  tr.querySelector(".star").onclick = () => {
    watch.has(sym) ? watch.delete(sym) : watch.add(sym);
    localStorage.setItem("tb.watch", JSON.stringify([...watch]));
    renderScreener();
  };
  tr.querySelector(".bell").onclick = () => {
    const c = coins.find(x => x.s === sym);
    const v = prompt(`Alert level for ${sym}${c ? " (last: "+fmtPx(c.l)+")" : ""}`, c ? fmtPx(c.l) : "");
    if(v === null) return;
    const level = parseFloat(String(v).replace(/,/g,""));
    if(isFinite(level) && level > 0) sendAlertAdd(sym, level);
  };
  return { tr, tds: tr.querySelectorAll("td"), lastVals:{} };
}
function setCell(r, idx, txt, cls, flash){
  const td = r.tds[idx];
  if(r.lastVals[idx] !== txt){
    td.textContent = txt;
    const keep = td.classList.contains("hide-m") ? "hide-m " : "";
    td.className = keep + (cls || "");
    if(flash){ td.classList.remove("f-up","f-down"); void td.offsetWidth; td.classList.add(flash); }
    r.lastVals[idx] = txt;
  }
}
function heatHTML(natr){
  if(natr==null) return `<span class="dim">—</span>`;
  const w = Math.min(natr*18, 60);
  const cls = natr>=2.5 ? "fire" : natr>=1.2 ? "hot" : "";
  return `<span class="heat ${cls}" style="width:${w}px"></span>${natr.toFixed(1)}`;
}
function visible(){
  let list = coins.filter(c => c.v >= minVol);
  if(wlOnly) list = list.filter(c => watch.has(c.s));
  if(searchQ) list = list.filter(c => c.s.includes(searchQ));
  list.sort((a,b) => {
    if(sortKey === "s") return sortDir * (a.s < b.s ? -1 : a.s > b.s ? 1 : 0);
    const va = a[sortKey] ?? -1e18, vb = b[sortKey] ?? -1e18;
    return sortDir * (va - vb);
  });
  return list.slice(0, 300);
}
function renderScreener(){
  const list = visible();
  $("cnt").textContent = coins.length;
  const tbody = $("tbody");
  let node = tbody.firstChild;
  const armedSyms = new Set(armedAlerts.map(a => a.sym));
  for(const c of list){
    let r = rowCache.get(c.s);
    if(!r){ r = makeRow(c.s); rowCache.set(c.s, r); }
    if(r.tr !== node) tbody.insertBefore(r.tr, node); else node = node.nextSibling;

    r.tds[0].firstChild.classList.toggle("on", watch.has(c.s));
    const tagEl = r.tr.querySelector(".tag");
    const tag = EX_TAG[c.x] || c.x;
    if(tagEl.textContent !== tag) tagEl.textContent = tag;

    const pv = prevPx.get(c.s);
    const dir = pv == null ? null : c.l > pv ? "f-up" : c.l < pv ? "f-down" : null;
    prevPx.set(c.s, c.l);

    setCell(r, 2, fmtPx(c.l), "", dir);
    setCell(r, 3, (c.c>0?"+":"")+c.c.toFixed(1), c.c>=0?"up":"down");
    setCell(r, 4, c.r==null?"—":c.r.toFixed(1), c.r!=null && c.r>=1 ? "up":"dim");
    if(r.lastVals.natr !== c.n){ r.tds[5].innerHTML = heatHTML(c.n); r.lastVals.natr = c.n; }
    setCell(r, 6, fmtBig(c.t), "dim");
    setCell(r, 7, fmtBig(c.v));
    r.tds[8].firstChild.classList.toggle("armed", armedSyms.has(c.s));
  }
  while(node){ const nx = node.nextSibling; tbody.removeChild(node); node = nx; }
}

/* ---------- board grid ---------- */
const TAG_COLORS = ["red", "green", "purple"];
const tagMap = new Map(JSON.parse(localStorage.getItem("tb.tags") || "[]"));
let tagFilter = "all";

function saveTags() { localStorage.setItem("tb.tags", JSON.stringify([...tagMap])); }

if (!localStorage.getItem("tb.tagsMigrated")) {
  for (const sym of watch) tagMap.set(sym, "green"); // migrate the existing single-star watchlist, once ever
  localStorage.setItem("tb.tagsMigrated", "1");
  saveTags();
}

function boardOpts() {
  return { minVol, searchQ, sortKey, sortDir, tagFilter, tags: tagMap };
}

$("tagPills").addEventListener("click", e => {
  const btn = e.target.closest(".tagPill");
  if (!btn) return;
  tagFilter = btn.dataset.tag;
  [...$("tagPills").children].forEach(b => b.classList.toggle("on", b === btn));
  renderBoardGrid();
  renderCoinList();
});

function openTagPopover(anchorEl, sym) {
  document.querySelector(".tagPopover")?.remove();
  const pop = document.createElement("div");
  pop.className = "tagPopover";
  const rect = anchorEl.getBoundingClientRect();
  pop.style.left = rect.left + "px";
  pop.style.top = (rect.bottom + 4) + "px";
  pop.innerHTML =
    `<button data-c="" style="background:transparent" title="Clear"></button>` +
    TAG_COLORS.map(c => `<button data-c="${c}" style="background:${
      c === "red" ? "var(--down)" : c === "green" ? "var(--up)" : "var(--tag-purple)"
    }"></button>`).join("");
  pop.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.c) tagMap.set(sym, b.dataset.c); else tagMap.delete(sym);
    saveTags();
    pop.remove();
    renderBoardGrid();
    renderCoinList();
  });
  document.body.appendChild(pop);
  setTimeout(() => document.addEventListener("click", function close(e) {
    if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("click", close); }
  }), 0);
}

const customMetrics = new Map(); // symbol -> { intervalLabel, natr, range }

async function fetchCustomMetric(sym, interval, limit) {
  const r = await fetch(`/api/candles?symbol=${sym}&interval=${interval}&limit=${limit}`);
  if (!r.ok) return null;
  const candles = await r.json();
  return { intervalLabel: `${interval}/${limit}`, natr: clientNatr(candles), range: clientAvgRange(candles) };
}

async function seedHistory(sym) {
  const gen = aggregatorGen; // capture before the await — a timeframe change in flight bumps this
  try {
    const r = await fetch(`/api/candles?symbol=${sym}&interval=${timeframe}&limit=200`);
    if (!r.ok) return;
    const candles = await r.json();
    if (gen !== aggregatorGen) return; // stale response: timeframe changed (new aggregator) while this fetch was in flight
    if (candles.length) {
      aggregator.seedBars(sym, candles);
      // redraw immediately so the panel doesn't sit blank/stale until the next ~1s snap tick
      drawPanelFor(sym, coins.find(c => c.s === sym)?.l);
    }
  } catch { /* live ticks will still build the chart from here */ }
}

function openPeriodPopover(anchorEl, sym) {
  document.querySelector(".periodPopover")?.remove();
  const pop = document.createElement("div");
  pop.className = "periodPopover";
  const rect = anchorEl.getBoundingClientRect();
  pop.style.left = rect.left + "px";
  pop.style.top = (rect.bottom + 4) + "px";
  pop.innerHTML =
    `<select class="ivl"><option value="1m">1m</option><option value="5m" selected>5m</option><option value="15m">15m</option><option value="1h">1h</option></select>` +
    `<input class="cnt" type="number" value="14" min="2" max="500">` +
    `<button class="btn go">Go</button>`;
  pop.querySelector(".go").onclick = async () => {
    const interval = pop.querySelector(".ivl").value;
    const limit = Math.max(2, Math.min(500, +pop.querySelector(".cnt").value || 14));
    try {
      const metric = await fetchCustomMetric(sym, interval, limit);
      if (metric) { customMetrics.set(sym, metric); renderBoardGrid(); renderCoinList(); }
    } finally {
      pop.remove();
    }
  };
  document.body.appendChild(pop);
  setTimeout(() => document.addEventListener("click", function close(e) {
    if (!pop.contains(e.target) && e.target !== anchorEl) { pop.remove(); document.removeEventListener("click", close); }
  }), 0);
}

function feedAggregator(list, ts) {
  for (const c of list) {
    // vol is hardcoded 0: the `snap` wire format only carries c.v, a ROLLING 24h cumulative
    // volume, not per-tick trade volume. A delta between snaps doesn't cleanly represent a
    // single bar's incremental volume, so it can't be derived client-side. The volume
    // histogram in chart.js is a placeholder until the backend streams real per-tick volume.
    aggregator.addTick(c.s, ts, c.l, 0);
    lastTickAt.set(c.s, ts);
    const bars = aggregator.getBars(c.s);
    const latestBarT = bars.length ? bars[bars.length - 1].t : null;
    const prevBarT = lastBarTsBySym.get(c.s);
    if (latestBarT !== prevBarT) {
      lastBarTsBySym.set(c.s, latestBarT);
      trendLinesBySym.set(c.s, findTrendLines(bars));
    }
  }
}

function makePanel(sym) {
  const el = document.createElement("div");
  el.className = "panel";
  el.innerHTML =
    `<div class="panelHead"><span class="freshDot"></span><span class="sym" style="cursor:pointer"></span>` +
    `<span class="tag"></span><span class="spacer"></span><span class="chg"></span></div>` +
    `<div class="panelHead metricsRow" style="cursor:pointer" title="Click to customize NATR/Range period"><span class="natr"></span><span class="range"></span></div>` +
    `<canvas></canvas>`;
  el.querySelector(".sym").onclick = e => openTagPopover(e.target, sym);
  el.querySelector(".metricsRow").onclick = e => openPeriodPopover(e.target, sym);
  seedHistory(sym);
  return { el, canvas: el.querySelector("canvas") };
}

function openDetailView(sym) {
  if (detailTimeframe === null) detailTimeframe = timeframe; // first-ever open takes whatever the global timeframe currently is
  detailSym = sym;
  $("detailSymLabel").textContent = sym;
  $("detailTimeframeSel").value = detailTimeframe;
  $("boardGrid").classList.add("hidden");
  $("boardDetail").classList.add("on");
  detailAggregator = createBarAggregator(TIMEFRAMES[detailTimeframe]);
  detailAggregatorGen++;
  detailLastBarTs = null;
  detailTrendLines = null;
  seedDetailHistory();
}

function closeDetailView() {
  detailSym = null;
  $("boardDetail").classList.remove("on");
  $("boardGrid").classList.remove("hidden");
}

function topWallsFor(sym) {
  const symWalls = walls.filter(w => w.sym === sym);
  const fmtWall = w => w && { ...w, ex: EX_TAG[w.ex] || w.ex, priceLabel: fmtPx(w.price) };
  const bid = fmtWall(symWalls.filter(w => w.side === "bid").sort((a, b) => b.usd - a.usd)[0]) || null;
  const ask = fmtWall(symWalls.filter(w => w.side === "ask").sort((a, b) => b.usd - a.usd)[0]) || null;
  return { bid, ask };
}

function drawPanelFor(sym, price) {
  const p = panelEls.get(sym);
  if (!p) return;
  const rect = p.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
  if (w > 0 && (p.canvas.width !== w || p.canvas.height !== h)) { p.canvas.width = w; p.canvas.height = h; }
  drawPanel(p.canvas, { bars: aggregator.getBars(sym), price, symbol: sym, trendLines: trendLinesBySym.get(sym), walls: topWallsFor(sym) });
}

function renderBoardGrid() {
  if (!$("view-board").classList.contains("on")) return; // Board tab not visible — skip wasted work, next snap while visible will catch up
  const list = selectCoins(coins, boardOpts());
  const pages = pageCount(list.length, gridDensity);
  gridPageCount = pages;
  gridPage = Math.min(gridPage, pages - 1);
  $("gridPageLabel").textContent = `${gridPage + 1}/${pages}`;
  const pageList = paginate(list, gridPage, gridDensity);
  const grid = $("boardGrid");
  // Connection/feed-level freshness: honest signal is "is the WS still delivering snap
  // messages at all", not per-symbol staleness (lastTickAt is stamped for every coin in
  // the same pass as this render, so no symbol could ever appear stale relative to itself).
  const stale = (Date.now() - lastSnapAt) > 5000;

  const seen = new Set();
  for (const c of pageList) {
    seen.add(c.s);
    let p = panelEls.get(c.s);
    if (!p) { p = makePanel(c.s); panelEls.set(c.s, p); }
    grid.appendChild(p.el);
    p.el.querySelector(".sym").textContent = c.s;
    p.el.querySelector(".tag").textContent = EX_TAG[c.x] || c.x;
    const chgEl = p.el.querySelector(".chg");
    chgEl.textContent = (c.c > 0 ? "+" : "") + c.c.toFixed(1) + "%";
    chgEl.className = "chg " + (c.c >= 0 ? "up" : "down");
    const cm = customMetrics.get(c.s);
    const natrEl = p.el.querySelector(".natr"), rangeEl = p.el.querySelector(".range");
    natrEl.textContent = cm ? `NATR ${cm.intervalLabel}: ${cm.natr?.toFixed(1) ?? "—"}` : `NATR: ${c.n?.toFixed(1) ?? "—"}`;
    rangeEl.textContent = cm ? `Rng: ${cm.range?.toFixed(1) ?? "—"}` : `Rng: ${c.r?.toFixed(1) ?? "—"}`;
    const tagColor = tagMap.get(c.s);
    const borderVar = tagColor === "green" ? "--up" : tagColor === "red" ? "--down" : tagColor === "purple" ? "--tag-purple" : null;
    p.el.style.borderColor = borderVar ? `var(${borderVar})` : "";
    p.el.querySelector(".freshDot").classList.toggle("stale", stale);
    drawPanelFor(c.s, c.l);
  }
  for (const [sym, p] of panelEls) {
    if (!seen.has(sym)) { p.el.remove(); panelEls.delete(sym); }
  }
}

/* ---------- density ---------- */
function renderDensity(){
  $("wallCnt").textContent = walls.length;
  const lanes = { ask: $("laneAsk"), bid: $("laneBid") };
  for(const side of ["ask","bid"]){
    const lane = lanes[side];
    lane.innerHTML =
      `<div class="grid" style="left:33.3%"></div><div class="grid" style="left:66.6%"></div>`+
      `<div class="axis"><span>0%</span><span>1%</span><span>2%</span><span>3% from price</span></div>`;
    const sideWalls = walls.filter(w => w.side === side).slice(0, 40);
    const maxUsd = Math.max(...sideWalls.map(w => w.usd), 1);
    for(const w of sideWalls){
      const d = document.createElement("div");
      const size = 18 + Math.sqrt(w.usd / maxUsd) * 42;
      d.className = `bubble ${side}`;
      d.style.width = d.style.height = size + "px";
      d.style.left = Math.min(w.dist / 3 * 100, 98) + "%";
      d.style.top = (18 + Math.random() * 55) + "%";
      d.textContent = w.sym;
      d.title = `${w.sym} · ${EX_TAG[w.ex]||w.ex} · ${w.side} ${fmtPx(w.price)} · $${fmtBig(w.usd)} · ${w.dist}% away`;
      lane.appendChild(d);
    }
    if(!sideWalls.length){
      const e = document.createElement("div");
      e.className = "empty"; e.textContent = "No significant walls right now";
      lane.appendChild(e);
    }
  }
  const body = $("denBody");
  if(!walls.length){ body.innerHTML = `<tr><td colspan="6" class="empty">Scanning order books…</td></tr>`; return; }
  body.innerHTML = walls.slice(0, 60).map(w =>
    `<tr><td style="text-align:left" class="sym">${w.sym}</td>`+
    `<td style="text-align:left" class="dim">${EX_TAG[w.ex]||w.ex}</td>`+
    `<td class="${w.side==="bid"?"side-b":"side-a"}">${w.side.toUpperCase()}</td>`+
    `<td>${fmtPx(w.price)}</td><td>${w.dist}%</td><td>$${fmtBig(w.usd)}</td></tr>`).join("");
}

/* ---------- sidebar panels ---------- */
function renderCoinList() {
  if (!$("view-board").classList.contains("on")) return; // sidebar lives inside the Board view — skip when it's not visible
  const list = selectCoins(coins, boardOpts()).slice(0, 100);
  $("coinListBody").innerHTML = list.map(c => {
    const tagColor = tagMap.get(c.s);
    const borderVar = tagColor === "green" ? "--up" : tagColor === "red" ? "--down" : tagColor === "purple" ? "--tag-purple" : null;
    const style = borderVar ? ` style="border-left-color:var(${borderVar})"` : "";
    return `<div class="clRow" data-sym="${c.s}"${style}>` +
      `<span class="s">${c.s}</span>` +
      `<span class="${c.c >= 0 ? 'up' : 'down'}">${(c.c > 0 ? '+' : '') + c.c.toFixed(1)}</span>` +
      `<span>${c.r == null ? "—" : c.r.toFixed(1)}</span>` +
      `<span>${c.n == null ? "—" : c.n.toFixed(1)}</span>` +
      `<span class="dim">${fmtBig(c.t)}</span>` +
      `<span class="dim">${fmtBig(c.v)}</span>` +
    `</div>`;
  }).join("") || `<div class="clRow dim">No coins match the current filters</div>`;
}

function renderDensityMap() {
  const large = walls.filter(w => w.usd >= 1_000_000);
  const medium = walls.filter(w => w.usd >= 300_000 && w.usd < 1_000_000);
  const small = walls.filter(w => w.usd < 300_000);
  const col = list => list.slice(0, 20).map(w =>
    `<span class="wallBadge ${w.side}">${EX_TAG[w.ex]||w.ex} ${w.sym} ${fmtBig(w.usd)}</span>`
  ).join("") || `<span class="dim" style="font-size:10px">none</span>`;
  $("densityMapBody").innerHTML =
    `<div class="densityCols"><h4>Large</h4><h4>Medium</h4><h4>Small</h4>` +
    `<div>${col(large)}</div><div>${col(medium)}</div><div>${col(small)}</div></div>`;
}

const listingEvents = [];
function renderListings(evt) {
  if (evt) { listingEvents.unshift(evt); if (listingEvents.length > 30) listingEvents.pop(); }
  $("listingsBody").innerHTML = listingEvents.map(e =>
    `<div class="listRow"><span class="s">${e.sym}</span><span class="dim">${fmtTime(e.ts)}</span></div>`
  ).join("") || `<div class="listRow dim">No new listings yet</div>`;
}

/* ---------- alerts ---------- */
function sendAlertAdd(sym, level){
  if(ws?.readyState === 1) ws.send(JSON.stringify({ t:"alert:add", sym, level }));
  if(Notification && Notification.permission === "default") Notification.requestPermission();
  toast(`Alert armed: <b>${sym}</b> @ ${fmtPx(level)}`);
}
function renderArmed(){
  const el = $("armed");
  if(!armedAlerts.length){ el.innerHTML = `<div class="item dim">None yet — set one above or via ⏰ in the screener.</div>`; return; }
  el.innerHTML = "";
  for(const a of armedAlerts){
    const d = document.createElement("div");
    d.className = "item";
    d.innerHTML = `<span class="k price">price</span><b>${a.sym}</b> ${a.side === "above" ? "≥" : "≤"} ${fmtPx(a.level)} <span class="del" title="Remove">✕</span>`;
    d.querySelector(".del").onclick = () => ws?.send(JSON.stringify({ t:"alert:del", sym:a.sym, level:a.level }));
    el.appendChild(d);
  }
}
function feedItem(evt, loud){
  const feed = $("feed");
  if(feed.firstChild?.classList?.contains("dim")) feed.innerHTML = "";
  const d = document.createElement("div");
  d.className = "item";
  d.innerHTML = `<span class="k ${evt.kind}">${evt.kind}</span><span>${evt.msg}</span><time>${fmtTime(evt.ts)}</time>`;
  feed.prepend(d);
  while(feed.children.length > 40) feed.lastChild.remove();
  if(loud){
    toast(`<b>${evt.sym}</b> ${evt.msg}`); beep();
    if(Notification?.permission === "granted") new Notification(`${evt.sym} — ${evt.kind}`, { body: evt.msg });
  }
}
$("alAdd").onclick = () => {
  const sym = $("alSym").value.trim().toUpperCase();
  const level = parseFloat($("alLevel").value.replace(/,/g,""));
  if(sym && isFinite(level) && level > 0){ sendAlertAdd(sym, level); $("alLevel").value = ""; }
};

/* ---------- toast + beep ---------- */
function toast(html){
  const el = document.createElement("div");
  el.className = "toast"; el.innerHTML = html;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 8000);
}
let audioCtx;
function beep(){
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(.001, audioCtx.currentTime + .4);
    o.start(); o.stop(audioCtx.currentTime + .4);
  }catch{}
}

/* ---------- controls ---------- */
document.querySelectorAll("nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("on", v.id === "view-" + b.dataset.view));
});
$("wlToggle").onclick = () => { wlOnly = !wlOnly; $("wlToggle").classList.toggle("on", wlOnly); renderScreener(); };
$("search").addEventListener("input", e => { searchQ = e.target.value.trim().toUpperCase(); renderScreener(); });
$("minVol").addEventListener("change", e => { minVol = +e.target.value; renderScreener(); });
document.addEventListener("keydown", e => {
  if(e.key === "/" && document.activeElement !== $("search")){ e.preventDefault(); $("search").focus(); }
});
function applySort(k) {
  if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = k === "s" ? 1 : -1; }
  syncSortHeaders();
  renderScreener();
  renderBoardGrid();
  renderCoinList();
}

function syncSortHeaders() {
  [...$("headRow").children].forEach(x => x.classList.toggle("sorted", x.dataset.k === sortKey));
  [...$("clHeadRow").children].forEach(x => x.classList.toggle("sorted", x.dataset.k === sortKey));
}

$("headRow").addEventListener("click", e => {
  const th = e.target.closest("th"); if(!th || !th.dataset.k) return;
  applySort(th.dataset.k);
});

$("clHeadRow").addEventListener("click", e => {
  const el = e.target.closest("span"); if(!el || !el.dataset.k) return;
  applySort(el.dataset.k);
});

$("sideToggle").onclick = () => {
  $("boardSidebar").classList.toggle("collapsed");
  $("sideToggle").textContent = $("boardSidebar").classList.contains("collapsed") ? "›" : "‹";
};

$("coinListBody").addEventListener("click", e => {
  const row = e.target.closest(".clRow");
  if (!row?.dataset.sym) return;
  openDetailView(row.dataset.sym);
});

$("detailClose").onclick = closeDetailView;

$("timeframeSel").addEventListener("change", e => {
  timeframe = e.target.value;
  aggregator = createBarAggregator(TIMEFRAMES[timeframe]);
  aggregatorGen++;
  trendLinesBySym.clear();
  lastBarTsBySym.clear();
  for (const sym of panelEls.keys()) seedHistory(sym);
  renderBoardGrid();
});

$("gridDensitySel").addEventListener("change", e => {
  gridDensity = +e.target.value;
  gridPage = 0;
  renderBoardGrid();
});

$("gridPrev").onclick = () => { gridPage = Math.max(0, gridPage - 1); renderBoardGrid(); };
$("gridNext").onclick = () => { gridPage = (gridPage + 1) % gridPageCount; renderBoardGrid(); }; // wrap to page 0 past the last page, for AUTO mode cycling
$("gridRefresh").onclick = () => renderBoardGrid();

let autoTimer = null;
$("autoMode").onclick = () => {
  const on = !$("autoMode").classList.contains("on");
  $("autoMode").classList.toggle("on", on);
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (on) autoTimer = setInterval(() => { $("gridNext").click(); }, 8000);
};
