const UP = "#41d99d", DOWN = "#ff5d73", AMBER = "#ffb454";

// Mirrors app.js's fmtPx exactly — chart.js stays a dependency-free pure module (no import
// from app.js), so this small formatter is duplicated rather than shared.
function fmtAxisPx(p) {
  if (p == null || !isFinite(p)) return "";
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return p.toPrecision(4);
}

export function drawPanel(canvas, { bars, price, symbol, trendLines, walls, hi24, lo24 }) {
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

  // Right-edge gutter for the Y-axis price scale, wide enough for the tallest expected
  // label at this panel's own font size (proportional to h, so it scales correctly with
  // the HiDPI-adjusted backing store — see drawPanelFor/renderDetailPanel in app.js).
  const axisFont = Math.max(9, Math.round(h * 0.032));
  ctx.font = `${axisFont}px monospace`;
  const axisW = Math.max(ctx.measureText(fmtAxisPx(yMax)).width, ctx.measureText(fmtAxisPx(yMin)).width) + 10;
  const chartW = w - axisW;

  const n = bars.length;
  const slot = chartW / n;
  const bw = Math.max(1, slot * 0.6);

  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.round(h * 0.28)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(symbol, chartW / 2, chartH / 2);
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

  // Y-axis price scale: top/mid/bottom labels in the right-edge gutter, always shown
  // (independent of price/walls/24h lines below) so every panel has readable price digits.
  ctx.save();
  ctx.font = `${axisFont}px monospace`;
  ctx.fillStyle = "#6e8a8c";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(fmtAxisPx(yMax), chartW + 4, axisFont * 0.7);
  ctx.fillText(fmtAxisPx((yMax + yMin) / 2), chartW + 4, chartH / 2);
  ctx.fillText(fmtAxisPx(yMin), chartW + 4, chartH - axisFont * 0.7);
  ctx.restore();

  // Suppress a 24h ref line's text label when it lands within the current-price tag's own
  // box (still drawn as a dashed line either way) — the price tag already covers that price
  // level, and stacking two text labels at nearly the same y is unreadable at panel scale.
  const priceY = price != null ? y(price) : null;
  const tagHalfH = (axisFont + 6) / 2;
  if (hi24 != null) drawRefLine(ctx, hi24, "H", AMBER, chartW, y, yMin, yMax, axisFont, priceY, tagHalfH);
  if (lo24 != null) drawRefLine(ctx, lo24, "L", AMBER, chartW, y, yMin, yMax, axisFont, priceY, tagHalfH);

  if (price != null) {
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(0, priceY);
    ctx.lineTo(chartW, priceY);
    ctx.stroke();
    ctx.restore();

    const lastBar = bars[bars.length - 1];
    const priceColor = lastBar && price < lastBar.o ? DOWN : UP;
    drawPriceTag(ctx, price, priceColor, chartW, axisW, priceY, axisFont);
  }

  if (walls?.bid) drawWallLine(ctx, walls.bid, "bid", chartW, y, yMin, yMax);
  if (walls?.ask) drawWallLine(ctx, walls.ask, "ask", chartW, y, yMin, yMax);

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

// Solid, filled price tag in the right-edge axis gutter — the current price, always
// legible, colored by whether the live price sits above/below the latest candle's open.
function drawPriceTag(ctx, price, color, chartW, axisW, yy, axisFont) {
  ctx.save();
  const boxH = axisFont + 6;
  ctx.fillStyle = color;
  ctx.fillRect(chartW, yy - boxH / 2, axisW, boxH);
  ctx.fillStyle = "#04120f";
  ctx.font = `bold ${axisFont}px monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(fmtAxisPx(price), chartW + 4, yy);
  ctx.restore();
}

// 24h high/low reference line — dashed across the candle area, clipped like wall lines
// when out of the current visible range, with a short "H"/"L" + price label in the gutter.
function drawRefLine(ctx, value, tag, color, chartW, y, yMin, yMax, axisFont, priceY, tagHalfH) {
  if (value < yMin || value > yMax) return;
  const yy = y(value);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.moveTo(0, yy);
  ctx.lineTo(chartW, yy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  if (priceY == null || Math.abs(yy - priceY) > tagHalfH) {
    ctx.fillStyle = color;
    ctx.font = `${axisFont}px monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(`${tag} ${fmtAxisPx(value)}`, chartW + 4, yy);
  }
  ctx.restore();
}

function drawWallLine(ctx, wall, side, chartW, y, yMin, yMax) {
  if (wall.price < yMin || wall.price > yMax) return;
  const yy = y(wall.price);
  const color = side === "bid" ? UP : DOWN;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(0, yy);
  ctx.lineTo(chartW, yy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  const label = `${wall.ex} ${fmtWallSize(wall.usd)} ${wall.priceLabel ?? wall.price}`;
  ctx.font = "9px monospace";
  const textW = ctx.measureText(label).width;
  const boxW = textW + 8, boxH = 14;
  const boxX = chartW - boxW - 2, boxY = yy - boxH / 2;
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
