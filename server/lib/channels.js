export const CHANNELS = {
  ticks: exchange => `ticks:${exchange}`,
  klines: exchange => `klines:${exchange}`,
  depth: (exchange, symbol) => `depth:${exchange}:${symbol}`,
  ctrl: exchange => `ctrl:${exchange}`,
  snap: "snap",
  density: "density",
  alerts: "alerts",
  cmdAlerts: "cmd:alerts"
};
