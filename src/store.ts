import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { AssetType, SnapshotInput, NearSnapshot, HistoryPoint } from './types';

// SQLite-backed snapshot store. One row per (key, ts, ticker); a "snapshot" is
// all rows sharing a (key, ts). Indexed for the two hot queries: nearest run to
// a target time (24h deltas) and a single ticker's history (charts). Requires a
// modern Node (better-sqlite3 ships prebuilt binaries for Node 18/20/22+).

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'trends.db');
const LEGACY_JSON = path.join(DATA_DIR, 'snapshots.json');
const RETENTION_DAYS = 30;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL'); // concurrent reads, durable appends
db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    key       TEXT    NOT NULL,
    ts        INTEGER NOT NULL,
    ticker    TEXT    NOT NULL,
    rank      INTEGER,
    mentions  INTEGER,
    upvotes   INTEGER,
    sentiment REAL,
    price     REAL,
    PRIMARY KEY (key, ts, ticker)
  );
  CREATE INDEX IF NOT EXISTS idx_key_ts        ON snapshots(key, ts);
  CREATE INDEX IF NOT EXISTS idx_key_ticker_ts ON snapshots(key, ticker, ts);
`);

export function keyOf(filter: string, type: AssetType): string {
  return `${type}:${filter}`;
}

interface Row {
  key: string;
  ts: number;
  ticker: string;
  rank: number;
  mentions: number | null;
  upvotes: number | null;
  sentiment: number | null;
  price: number | null;
}

// ---- prepared statements ----------------------------------------------------
const insertRow = db.prepare(
  `INSERT OR REPLACE INTO snapshots (key, ts, ticker, rank, mentions, upvotes, sentiment, price)
   VALUES (@key, @ts, @ticker, @rank, @mentions, @upvotes, @sentiment, @price)`
);
const pruneStmt = db.prepare('DELETE FROM snapshots WHERE ts < ?');
const distinctTsStmt = db.prepare('SELECT DISTINCT ts FROM snapshots WHERE key = ? ORDER BY ts ASC');
const nearestTsStmt = db.prepare(
  `SELECT ts FROM snapshots WHERE key = ? AND ABS(ts - @target) <= @tol
   GROUP BY ts ORDER BY ABS(ts - @target) ASC LIMIT 1`
);
const rowsForTsStmt = db.prepare('SELECT ticker, rank, mentions, upvotes, sentiment, price FROM snapshots WHERE key = ? AND ts = ? ORDER BY rank ASC');
const historyStmt = db.prepare('SELECT ts, mentions, price FROM snapshots WHERE key = ? AND ticker = ? ORDER BY ts ASC');

const insertMany = db.transaction((rows: Row[]) => {
  for (const r of rows) insertRow.run(r);
});

// `tickers` is an ordered ranking; index+1 is its rank. Each may carry price.
export function addSnapshot(filter: string, type: AssetType, tickers: SnapshotInput[], ts: number): void {
  const key = keyOf(filter, type);
  const rows: Row[] = tickers.map((t, i) => ({
    key,
    ts,
    ticker: t.ticker,
    rank: i + 1,
    mentions: t.mentions ?? null,
    upvotes: t.upvotes ?? null,
    sentiment: t.sentiment ?? null,
    price: t.price ?? null,
  }));
  insertMany(rows);
  pruneStmt.run(ts - RETENTION_DAYS * 24 * 3600 * 1000);
}

// Lightweight run descriptors in chronological order (callers only need ts).
export function snapshotsFor(filter: string, type: AssetType): { ts: number }[] {
  return distinctTsStmt.all(keyOf(filter, type)) as { ts: number }[];
}

// The snapshot run closest to (now - hoursAgo), within a tolerance window.
export function snapshotNear(filter: string, type: AssetType, now: number, hoursAgo: number, toleranceHours = 12): NearSnapshot | null {
  const key = keyOf(filter, type);
  const target = now - hoursAgo * 3600 * 1000;
  const tol = toleranceHours * 3600 * 1000;
  const hit = nearestTsStmt.get(key, { target, tol }) as { ts: number } | undefined;
  if (!hit) return null;

  const rows = rowsForTsStmt.all(key, hit.ts) as Omit<Row, 'key' | 'ts'>[];
  const data: NearSnapshot['data'] = {};
  const order: string[] = [];
  for (const r of rows) {
    data[r.ticker] = { m: r.mentions, u: r.upvotes, s: r.sentiment, p: r.price };
    order.push(r.ticker);
  }
  return { ts: hit.ts, key, data, order };
}

// Per-ticker history for charts.
export function historyFor(filter: string, type: AssetType, ticker: string): HistoryPoint[] {
  const rows = historyStmt.all(keyOf(filter, type), ticker) as { ts: number; mentions: number | null; price: number | null }[];
  return rows.map((r) => ({ ts: r.ts, mentions: r.mentions, price: r.price }));
}

// ---- one-time migration from the legacy JSON store --------------------------
function migrateLegacyIfNeeded(): void {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number }).n;
  if (count > 0 || !fs.existsSync(LEGACY_JSON)) return;
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8')) as {
      snapshots?: { key: string; ts: number; data?: Record<string, { m?: number; u?: number; s?: number; p?: number }>; order?: string[] }[];
    };
    const rows: Row[] = [];
    for (const s of legacy.snapshots || []) {
      const order = s.order || Object.keys(s.data || {});
      order.forEach((ticker, i) => {
        const d = (s.data || {})[ticker] || {};
        rows.push({ key: s.key, ts: s.ts, ticker, rank: i + 1, mentions: d.m ?? null, upvotes: d.u ?? null, sentiment: d.s ?? null, price: d.p ?? null });
      });
    }
    if (rows.length) {
      insertMany(rows);
      console.log(`Migrated ${rows.length} legacy snapshot rows from snapshots.json into SQLite.`);
    }
  } catch (e) {
    console.warn('Legacy snapshot migration skipped:', (e as Error).message);
  }
}
migrateLegacyIfNeeded();

export { db, DB_FILE };
