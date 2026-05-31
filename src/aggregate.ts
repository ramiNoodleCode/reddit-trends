import { dictFor, BLACKLIST } from './tickers';
import * as reddit from './reddit';
import * as apewisdom from './apewisdom';
import * as market from './market';
import * as sentiment from './sentiment';
import * as store from './store';
import * as mock from './mock';
import type {
  AssetType, FilterDef, FilterInfo, Doc, RawRow, BaseRow, EnrichedRow,
  Source, Divergence, RankingPayload, TickerDetail, SnapshotInput,
} from './types';

// ---- Filter definitions (which subreddits feed each tab) --------------------

const FILTERS: Record<string, FilterDef> = {
  // Stocks
  'all-stocks': { label: 'All', type: 'stocks', subs: ['wallstreetbets', 'stocks', 'stockmarket', 'investing', 'options', 'Superstonk', 'pennystocks'] },
  wallstreetbets: { label: 'wallstreetbets', type: 'stocks', subs: ['wallstreetbets'] },
  stocks: { label: 'stocks', type: 'stocks', subs: ['stocks'] },
  stockmarket: { label: 'StockMarket', type: 'stocks', subs: ['StockMarket'] },
  investing: { label: 'investing', type: 'stocks', subs: ['investing'] },
  options: { label: 'options', type: 'stocks', subs: ['options'] },
  // Crypto
  'all-crypto': { label: 'All', type: 'crypto', subs: ['CryptoCurrency', 'SatoshiStreetBets', 'CryptoMoonShots', 'Bitcoin', 'ethereum'] },
  CryptoCurrency: { label: 'CryptoCurrency', type: 'crypto', subs: ['CryptoCurrency'] },
  SatoshiStreetBets: { label: 'SatoshiStreetBets', type: 'crypto', subs: ['SatoshiStreetBets'] },
  CryptoMoonShots: { label: 'CryptoMoonShots', type: 'crypto', subs: ['CryptoMoonShots'] },
  Bitcoin: { label: 'Bitcoin', type: 'crypto', subs: ['Bitcoin'] },
  ethereum: { label: 'ethereum', type: 'crypto', subs: ['ethereum'] },
};

export function listFilters(): FilterInfo[] {
  return Object.entries(FILTERS).map(([id, f]) => ({ id, label: f.label, type: f.type }));
}

// ---- Ticker extraction ------------------------------------------------------

const CASHTAG = /\$([A-Za-z]{1,5})\b/g;
const BARE = /\b([A-Z]{1,5})\b/g;

interface Accum {
  mentions: number;
  upvotes: number;
  sentNet: number;
  sentSamples: number;
}

export function extractFromDocs(docs: Doc[], type: AssetType): RawRow[] {
  const dict = dictFor(type);
  const acc: Record<string, Accum> = {};

  for (const doc of docs) {
    const found = new Set<string>();

    let m: RegExpExecArray | null;
    CASHTAG.lastIndex = 0;
    while ((m = CASHTAG.exec(doc.text))) {
      const sym = m[1].toUpperCase();
      if (dict[sym]) found.add(sym); // $-prefixed bypasses the blacklist
    }
    BARE.lastIndex = 0;
    while ((m = BARE.exec(doc.text))) {
      const sym = m[1];
      if (dict[sym] && !BLACKLIST.has(sym)) found.add(sym);
    }

    if (found.size === 0) continue;
    const s = sentiment.scoreText(doc.text);
    for (const sym of found) {
      const a = acc[sym] || (acc[sym] = { mentions: 0, upvotes: 0, sentNet: 0, sentSamples: 0 });
      a.mentions += 1;
      a.upvotes += doc.score || 0;
      a.sentNet += s;
      a.sentSamples += 1;
    }
  }

  return Object.entries(acc)
    .map(([ticker, a]): RawRow => ({
      ticker,
      name: dict[ticker],
      mentions: a.mentions,
      upvotes: a.upvotes,
      sentiment: +sentiment.normalize(a.sentNet, a.sentSamples).toFixed(2),
    }))
    .sort((x, y) => y.mentions - x.mentions);
}

// ---- Building a ranking with deltas vs. 24h-ago history ---------------------

function withDeltas(filter: string, type: AssetType, rows: RawRow[], now: number): BaseRow[] {
  const prevSnap = store.snapshotNear(filter, type, now, 24);
  const prevOrder = prevSnap ? prevSnap.order : null;
  const prevData = prevSnap ? prevSnap.data : null;

  return rows.map((r, i): BaseRow => {
    const rank = i + 1;
    let mentions24h: number | null = null;
    let changePct: number | null = null;
    let rankChange: BaseRow['rankChange'] = null;

    if (prevData && prevData[r.ticker]) {
      mentions24h = prevData[r.ticker].m;
      if (mentions24h != null && mentions24h > 0) {
        changePct = Math.round(((r.mentions - mentions24h) / mentions24h) * 100);
      }
    }
    if (prevOrder) {
      const prevIdx = prevOrder.indexOf(r.ticker);
      rankChange = prevIdx === -1 ? 'new' : prevIdx - i;
    }

    return {
      rank,
      ticker: r.ticker,
      name: r.name,
      mentions: r.mentions,
      mentions_24h: mentions24h,
      changePct,
      upvotes: r.upvotes,
      rankChange,
      sentiment: r.sentiment,
      sentimentLabel: sentiment.label(r.sentiment),
    };
  });
}

// ---- Public API: cached ranking per filter ---------------------------------

const CACHE: Record<string, { ts: number; payload: RankingPayload }> = {};
const CACHE_TTL_MS = 5 * 60 * 1000;
// Minimum spacing between persisted snapshots per filter. Lower it (e.g. to
// match a tighter cron cadence) via SNAPSHOT_MIN_GAP_MIN.
const SNAPSHOT_MIN_GAP_MS = (Number(process.env.SNAPSHOT_MIN_GAP_MIN) || 30) * 60 * 1000;
const TOP_N = 100;

function lastSnapshotTs(filter: string, type: AssetType): number {
  const snaps = store.snapshotsFor(filter, type);
  return snaps.length ? snaps[snaps.length - 1].ts : 0;
}

// Persist a snapshot at most every SNAPSHOT_MIN_GAP_MS per filter.
function snapshotIfDue(filterId: string, type: AssetType, rows: SnapshotInput[], now: number): void {
  if (now - lastSnapshotTs(filterId, type) > SNAPSHOT_MIN_GAP_MS) {
    store.addSnapshot(filterId, type, rows, now);
  }
}

function pack(filterId: string, f: FilterDef, source: Source, now: number, ranked: EnrichedRow[]): RankingPayload {
  return { filter: filterId, label: f.label, type: f.type, source, updatedAt: now, count: ranked.length, rows: ranked };
}

// Seed a real 24h-ago snapshot from ApeWisdom's mentions_24h_ago so the detail
// chart shows the genuine 24h trend immediately (more points accrue over time).
function seedApeHistory(filterId: string, type: AssetType, ranked: BaseRow[], now: number): void {
  if (store.snapshotNear(filterId, type, now, 24)) return;
  const yday: SnapshotInput[] = ranked
    .filter((r) => r.mentions_24h != null)
    .map((r) => ({ ticker: r.ticker, mentions: r.mentions_24h, upvotes: 0, sentiment: 0 }))
    .sort((a, b) => (b.mentions ?? 0) - (a.mentions ?? 0));
  if (yday.length) store.addSnapshot(filterId, type, yday, now - 24 * 3600 * 1000);
}

// Map a mention-% and price-% into a divergence classification — the "is the
// hype matching the move?" signal that makes this more than a mention counter.
function divergenceOf(mentionPct: number | null, pricePct: number | null): Divergence {
  if (mentionPct == null || pricePct == null) return null;
  if (mentionPct >= 25 && pricePct <= -1) return 'hype';
  if (mentionPct <= -10 && pricePct >= 1) return 'fade';
  if ((mentionPct > 0 && pricePct > 0) || (mentionPct < 0 && pricePct < 0)) return 'aligned';
  return 'mixed';
}

// Add the no-key derived columns + market enrichment to a ranked list.
async function enrichRanking(ranked: BaseRow[], type: AssetType, now: number): Promise<EnrichedRow[]> {
  const total = ranked.reduce((s, r) => s + (r.mentions || 0), 0) || 1;
  const maxMentions = ranked.reduce((m, r) => Math.max(m, r.mentions || 0), 0) || 1;
  const symbols = ranked.map((r) => r.ticker);

  let quotes: Record<string, { price: number | null; changePct: number | null; volume: number | null; marketCap?: number | null; dayHigh?: number | null; dayLow?: number | null }> = {};
  try {
    quotes = type === 'crypto' ? await market.getCryptoQuotes(symbols, now) : await market.getStockQuotes(symbols, now);
  } catch {
    quotes = {};
  }

  return ranked.map((r): EnrichedRow => {
    const q = quotes[r.ticker] || ({} as (typeof quotes)[string]);
    const g = r.rankChange === 'new' ? 100 : r.changePct == null ? 50 : Math.max(0, Math.min(100, ((r.changePct + 50) / 200) * 100));
    const heat = Math.round(0.6 * ((r.mentions / maxMentions) * 100) + 0.4 * g);
    const priceChangePct = q.changePct ?? null;

    return {
      ...r,
      mentionChange: r.mentions_24h == null ? null : r.mentions - r.mentions_24h,
      upvotesPerMention: r.mentions > 0 ? Math.round(r.upvotes / r.mentions) : null,
      shareOfVoice: +((r.mentions / total) * 100).toFixed(1),
      heat,
      isNew: r.rankChange === 'new',
      price: q.price ?? null,
      priceChangePct,
      marketCap: q.marketCap ?? null,
      volume: q.volume ?? null,
      dayHigh: q.dayHigh ?? null,
      dayLow: q.dayLow ?? null,
      spark: null,
      divergence: divergenceOf(r.changePct, priceChangePct),
    };
  });
}

// Resolve a ranking from the best available source:
//   1. your own Reddit OAuth pipeline (if credentials are configured)
//   2. ApeWisdom's free public API (real data, no auth) — the default
//   3. deterministic sample data (offline fallback)
async function compute(filterId: string, now: number): Promise<RankingPayload> {
  const f = FILTERS[filterId];
  if (!f) throw new Error(`Unknown filter: ${filterId}`);

  let ranked: BaseRow[] | null = null;
  let source: Source | null = null;

  if (reddit.isConfigured()) {
    try {
      const docs = await reddit.fetchDocuments(f.subs);
      const rows = extractFromDocs(docs, f.type).slice(0, TOP_N);
      if (rows.length < 5) throw new Error('Too few tickers from Reddit');
      ranked = withDeltas(filterId, f.type, rows, now);
      source = 'reddit';
    } catch {
      /* fall through */
    }
  }

  if (!ranked && apewisdom.hasFilter(filterId)) {
    try {
      ranked = await apewisdom.fetchRanking(filterId, TOP_N);
      seedApeHistory(filterId, f.type, ranked, now);
      source = 'apewisdom';
    } catch {
      /* fall through */
    }
  }

  if (!ranked) {
    const rows = mock.buildRanking(f.type, filterId).slice(0, TOP_N);
    if (!store.snapshotNear(filterId, f.type, now, 24)) {
      for (const s of mock.backdatedSnapshots(rows, now, 6)) {
        store.addSnapshot(filterId, f.type, s.rows, s.ts);
      }
    }
    ranked = withDeltas(filterId, f.type, rows, now);
    source = 'mock';
  }

  // Enrich first, then snapshot — so price is captured in the stored history.
  const enriched = await enrichRanking(ranked, f.type, now);
  snapshotIfDue(filterId, f.type, enriched, now);
  return pack(filterId, f, source as Source, now, enriched);
}

export async function getRanking(filterId: string, { force = false }: { force?: boolean } = {}, now: number = Date.now()): Promise<RankingPayload> {
  const cached = CACHE[filterId];
  if (!force && cached && now - cached.ts < CACHE_TTL_MS) return cached.payload;
  const payload = await compute(filterId, now);
  CACHE[filterId] = { ts: now, payload };
  return payload;
}

export async function getDetail(filterId: string, ticker: string, now: number = Date.now()): Promise<TickerDetail> {
  const f = FILTERS[filterId];
  if (!f) throw new Error(`Unknown filter: ${filterId}`);
  const sym = ticker.toUpperCase();
  const payload = await getRanking(filterId, {}, now);
  const row = payload.rows.find((r) => r.ticker === sym) ?? null;
  const history = store.historyFor(filterId, f.type, sym);

  let marketDetail = null;
  try {
    marketDetail = f.type === 'crypto' ? await market.getCryptoDetail(sym, now) : await market.getStockDetail(sym, now);
  } catch {
    marketDetail = null;
  }

  return { filter: filterId, ticker: sym, row, history, marketDetail };
}

export async function refreshAll(now: number = Date.now()): Promise<(RankingPayload | { filter: string; error: string })[]> {
  const out: (RankingPayload | { filter: string; error: string })[] = [];
  for (const id of Object.keys(FILTERS)) {
    try {
      out.push(await getRanking(id, { force: true }, now));
    } catch (e) {
      out.push({ filter: id, error: (e as Error).message });
    }
  }
  return out;
}

export { FILTERS };
