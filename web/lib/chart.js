const UP = "#41d99d", DOWN = "#ff5d73";

export function drawPanel(canvas, { bars, price, symbol, trendLines, walls }) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!bars || !bars.length || !w || !h) return;

  const volH = Math.round(h * 0.18);
  const chartH = h - volH;
  const highs = bars.map(b => b.h), lows = bars.map(b => b.l);
  const lo = Math.min(...lows, price ?? Infinity);
  const hi = Math.max(...highs, price ?? -Infinity);
  const pad = (hi - lo) * 0.08 || 1;
  const yMin = lo - pad, yMax = hi + pad;
  const y = v => chartH - ((v - yMin) / (yMax - yMin)) * chartH;

  const n = bars.length;
  const slot = w / n;
  const bw = Math.max(1, slot * 0.6);

  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.round(h * 0.28)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(symbol, w / 2, chartH / 2);
  ctx.restore();

  bars.forEach((b, i) => {
    const cx = i * slot + slot / 2;
    const up = b.c >= b.o;
    ctx.strokeStyle = ctx.fillStyle = up ? UP : DOWN;
    ctx.beginPath();
    ctx.moveTo(cx, y(b.h));
    ctx.lineTo(cx, y(b.l));
    ctx.stroke();
    const top = y(Math.max(b.o, b.c)), bot = y(Math.min(b.o, b.c));
    ctx.fillRect(cx - bw / 2, top, bw, Math.max(1, bot - top));
  });

  // NOTE: bar.v is currently always 0 — feedAggregator() in app.js calls addTick() with
  // vol=0 because the `snap` wire format only exposes a ROLLING 24h cumulative volume
  // (coin.v), not per-tick trade volume. A delta between snapshots of a rolling sum does
  // not cleanly represent a single bar's incremental volume, so this histogram is a
  // placeholder until the backend streams real per-tick volume — do not "fix" it with a
  // delta-based approximation.
  const maxV = Math.max(...bars.map(b => b.v), 1);
  bars.forEach((b, i) => {
    const cx = i * slot + slot / 2;
    const vh = (b.v / maxV) * volH;
    ctx.fillStyle = b.c >= b.o ? "rgba(65,217,157,.4)" : "rgba(255,93,115,.4)";
    ctx.fillRect(cx - bw / 2, h - vh, bw, vh);
  });

  if (price != null) {
    ctx.strokeStyle = "#ffffff";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(0, y(price));
    ctx.lineTo(w, y(price));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (walls?.bid) drawWallLine(ctx, walls.bid, "bid", w, y, yMin, yMax);
  if (walls?.ask) drawWallLine(ctx, walls.ask, "ask", w, y, yMin, yMax);

  if (trendLines?.resistance) drawTrendLine(ctx, trendLines.resistance, n, slot, y, DOWN);
  if (trendLines?.support) drawTrendLine(ctx, trendLines.support, n, slot, y, UP);
}

function drawTrendLine(ctx, line, n, slot, y, color) {
  const x1 = line.p1.i * slot + slot / 2, x2 = (n - 1) * slot + slot / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(x1, y(line.valueAt(line.p1.i)));
  ctx.lineTo(x2, y(line.valueAt(n - 1)));
  ctx.stroke();
  ctx.restore();
}

function drawWallLine(ctx, wall, side, w, y, yMin, yMax) {
  if (wall.price < yMin || wall.price > yMax) return;
  const yy = y(wall.price);
  const color = side === "bid" ? UP : DOWN;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(0, yy);
  ctx.lineTo(w, yy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  const label = `${wall.ex} ${fmtWallSize(wall.usd)} ${wall.price}`;
  ctx.font = "9px monospace";
  const textW = ctx.measureText(label).width;
  const boxW = textW + 8, boxH = 14;
  const boxX = w - boxW - 2, boxY = yy - boxH / 2;
  ctx.fillStyle = side === "bid" ? "rgba(65,217,157,.18)" : "rgba(255,93,115,.18)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.6;
  ctx.strokeRect(boxX, boxY, boxW, boxH);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, boxX + 4, yy);
  ctx.restore();
}

function fmtWallSize(usd) {
  if (usd >= 1e6) return (usd / 1e6).toFixed(usd >= 1e7 ? 0 : 1) + "M";
  if (usd >= 1e3) return Math.round(usd / 1e3) + "K";
  return String(Math.round(usd));
}
