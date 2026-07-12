import Database from "better-sqlite3";

const DDL = `
CREATE TABLE IF NOT EXISTS candles (
  exchange TEXT NOT NULL,
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  open_time INTEGER NOT NULL,
  o REAL NOT NULL,
  h REAL NOT NULL,
  l REAL NOT NULL,
  c REAL NOT NULL,
  v REAL NOT NULL,
  PRIMARY KEY (exchange, symbol, interval, open_time)
);

CREATE TABLE IF NOT EXISTS alerts (
  base TEXT NOT NULL,
  level REAL NOT NULL,
  side TEXT NOT NULL,
  PRIMARY KEY (base, level)
);

CREATE TABLE IF NOT EXISTS alert_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  sym TEXT NOT NULL,
  msg TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_history_ts ON alert_history (ts);
`;

export function initDb(pathOrMemory) {
  const db = new Database(pathOrMemory);
  if (pathOrMemory !== ":memory:") db.pragma("journal_mode = WAL");
  db.exec(DDL);
  return db;
}
