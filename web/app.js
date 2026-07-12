import { createBarAggregator, selectCoins, paginate, pageCount, findTrendLines } from "./lib/metrics.js";
import { drawPanel } from "./lib/chart.js";

const $ = id => document.getElementById(id);
const EX_TAG = { binance:"BI-F", bybit:"BY-F", okx:"OK-F", mock:"SIM" };

let coins = [];                 // latest snapshot
const prevPx = new Map();       // sym -> last price (for flashes)
let armedAlerts = [];           // [{sym, level, side}]
let walls = [];
let sortKey = "v", sortDir = -1, searchQ = "", minVol = 10_000_000, wlOnly = false;
const watch = new Set(JSON.parse(localStorage.getItem("tb.watch") || "[]"));

const TIMEFRAMES = { "1M": 60_000, "5M": 300_000, "15M": 900_000 };
let timeframe = "5M";
let aggregator = createBarAggregator(TIMEFRAMES[timeframe]);
const trendLinesBySym = new Map();   // symbol -> {resistance, support}
const lastBarTsBySym = new Map();    // symbol -> last-seen bar's open ts (to know when a bar closed)
const lastTickAt = new Map();        // symbol -> ts, for the freshness dot
let gridDensity = 9;                 // 3 / 6 / 9, Task 7 adds the selector
let gridPage = 0;
const panelEls = new Map();          // symbol -> {el, canvas}

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
      $("klAge").textContent = m.klineTs ? Math.round((Date.now()-m.klineTs)/1000)+"s ago" : "loading…";
      renderScreener();
      feedAggregator(coins, Date.now());
      renderBoardGrid();
    } else if(m.t === "hello"){
      armedAlerts = m.alerts || []; walls = m.walls || []; renderStatus(m.status);
      renderArmed(); renderDensity();
      for(const a of (m.recent||[]).slice(-15)) feedItem(a, false);
    } else if(m.t === "density"){
      walls = m.walls || []; renderDensity();
    } else if(m.t === "alerts"){
      armedAlerts = m.list || []; renderArmed(); renderScreener();
    } else if(m.t === "alert"){
      feedItem(m, true);
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
function boardOpts() {
  return { minVol, searchQ, sortKey, sortDir, tagFilter: "all", tags: new Map() }; // Task 5 wires real tags
}

function feedAggregator(list, ts) {
  for (const c of list) {
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
    `<div class="panelHead"><span class="freshDot"></span><span class="sym"></span>` +
    `<span class="tag"></span><span class="spacer"></span><span class="chg"></span></div>` +
    `<canvas></canvas>`;
  return { el, canvas: el.querySelector("canvas") };
}

function drawPanelFor(sym, price) {
  const p = panelEls.get(sym);
  if (!p) return;
  const rect = p.canvas.getBoundingClientRect();
  const w = Math.round(rect.width), h = Math.round(rect.height);
  if (w > 0 && (p.canvas.width !== w || p.canvas.height !== h)) { p.canvas.width = w; p.canvas.height = h; }
  drawPanel(p.canvas, { bars: aggregator.getBars(sym), price, symbol: sym, trendLines: trendLinesBySym.get(sym) });
}

function renderBoardGrid() {
  const list = selectCoins(coins, boardOpts());
  const pages = pageCount(list.length, gridDensity);
  gridPage = Math.min(gridPage, pages - 1);
  const pageList = paginate(list, gridPage, gridDensity);
  const grid = $("boardGrid");

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
    const stale = (Date.now() - (lastTickAt.get(c.s) ?? 0)) > 5000;
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
$("headRow").addEventListener("click", e => {
  const th = e.target.closest("th"); if(!th || !th.dataset.k) return;
  const k = th.dataset.k;
  if(sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = k === "s" ? 1 : -1; }
  [...$("headRow").children].forEach(x => x.classList.toggle("sorted", x === th));
  renderScreener();
});

$("sideToggle").onclick = () => {
  $("boardSidebar").classList.toggle("collapsed");
  $("sideToggle").textContent = $("boardSidebar").classList.contains("collapsed") ? "›" : "‹";
};
