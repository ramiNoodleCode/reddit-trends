'use strict';

const { dictFor, BLACKLIST } = require('./tickers');
const reddit = require('./reddit');
const apewisdom = require('./apewisdom');
const market = require('./market');
const sentiment = require('./sentiment');
const store = require('./store');
const mock = require('./mock');

// ---- Filter definitions (which subreddits feed each tab) --------------------

const FILTERS = {
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

function listFilters() {
  return Object.entries(FILTERS).map(([id, f]) => ({ id, label: f.label, type: f.type }));
}

// ---- Ticker extraction ------------------------------------------------------

const CASHTAG = /\$([A-Za-z]{1,5})\b/g;
const BARE = /\b([A-Z]{1,5})\b/g;

function extractFromDocs(docs, type) {
  const dict = dictFor(type);
  const acc = {}; // sym -> { mentions, upvotes, sentNet, sentSamples }

  for (const doc of docs) {
    const found = new Set();

    let m;
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
    .map(([ticker, a]) => ({
      ticker,
      name: dict[ticker],
      mentions: a.mentions,
      upvotes: a.upvotes,
      sentiment: +sentiment.normalize(a.sentNet, a.sentSamples).toFixed(2),
    }))
    .sort((x, y) => y.mentions - x.mentions);
}

// ---- Building a ranking with deltas vs. 24h-ago history ---------------------

function withDeltas(filter, type, rows, now) {
  const prevSnap = store.snapshotNear(filter, type, now, 24);
  const prevOrder = prevSnap ? prevSnap.order : null;
  const prevData = prevSnap ? prevSnap.data : null;

  return rows.map((r, i) => {
    const rank = i + 1;
    let mentions24h = null;
    let changePct = null;
    let rankChange = null; // positive = climbed, 'new' = wasn't ranked before

    if (prevData && prevData[r.ticker]) {
      mentions24h = prevData[r.ticker].m;
      const change = r.mentions - mentions24h;
      changePct = mentions24h > 0 ? Math.round((change / mentions24h) * 100) : null;
    }
    if (prevOrder) {
      const prevIdx = prevOrder.indexOf(r.ticker);
      rankChange = prevIdx === -1 ? 'new' : prevIdx - i; // old rank minus new rank
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

const CACHE = {}; // filter id -> { ts, payload }
const CACHE_TTL_MS = 5 * 60 * 1000;
// Minimum spacing between persisted snapshots per filter. Lower it (e.g. to
// match a tighter cron cadence) via SNAPSHOT_MIN_GAP_MIN.
const SNAPSHOT_MIN_GAP_MS = (Number(process.env.SNAPSHOT_MIN_GAP_MIN) || 30) * 60 * 1000;
const TOP_N = 100;

function lastSnapshotTs(filter, type) {
  const snaps = store.snapshotsFor(filter, type);
  return snaps.length ? snaps[snaps.length - 1].ts : 0;
}

// Persist a snapshot at most every 30 min so history accrues without spam.
function snapshotIfDue(filterId, type, rows, now) {
  if (now - lastSnapshotTs(filterId, type) > SNAPSHOT_MIN_GAP_MS) {
    store.addSnapshot(filterId, type, rows, now);
  }
}

function pack(filterId, f, source, now, ranked) {
  return {
    filter: filterId,
    label: f.label,
    type: f.type,
    source,
    updatedAt: now,
    count: ranked.length,
    rows: ranked,
  };
}

// Seed a real 24h-ago snapshot from ApeWisdom's mentions_24h_ago so the detail
// chart shows the genuine 24h trend immediately (more points accrue over time).
function seedApeHistory(filterId, type, ranked, now) {
  if (store.snapshotNear(filterId, type, now, 24)) return;
  const yday = ranked
    .filter((r) => r.mentions_24h != null)
    .map((r) => ({ ticker: r.ticker, name: r.name, mentions: r.mentions_24h, upvotes: 0, sentiment: 0 }))
    .sort((a, b) => b.mentions - a.mentions);
  if (yday.length) store.addSnapshot(filterId, type, yday, now - 24 * 3600 * 1000);
}

// Map a mention-% and price-% into a divergence classification — the "is the
// hype matching the move?" signal that makes this more than a mention counter.
function divergenceOf(mentionPct, pricePct) {
  if (mentionPct == null || pricePct == null) return null;
  if (mentionPct >= 25 && pricePct <= -1) return 'hype'; // chatter surging, price falling
  if (mentionPct <= -10 && pricePct >= 1) return 'fade'; // chatter cooling, price rising
  if ((mentionPct > 0 && pricePct > 0) || (mentionPct < 0 && pricePct < 0)) return 'aligned';
  return 'mixed';
}

// Add the no-key derived columns + market enrichment (price, day move, market
// cap/volume) to a ranked list. Market lookups are cached and fail soft.
async function enrichRanking(ranked, type, now) {
  const total = ranked.reduce((s, r) => s + (r.mentions || 0), 0) || 1;
  const maxMentions = ranked.reduce((m, r) => Math.max(m, r.mentions || 0), 0) || 1;
  const symbols = ranked.map((r) => r.ticker);

  let quotes = {};
  try {
    quotes = type === 'crypto' ? await market.getCryptoQuotes(symbols, now) : await market.getStockQuotes(symbols, now);
  } catch (_) {
    quotes = {};
  }

  return ranked.map((r) => {
    const q = quotes[r.ticker] || {};
    // growth score: map mention 24h% from [-50,150] to [0,100]; NEW counts as hot.
    const g = r.rankChange === 'new' ? 100 : r.changePct == null ? 50 : Math.max(0, Math.min(100, ((r.changePct + 50) / 200) * 100));
    const heat = Math.round(0.6 * ((r.mentions / maxMentions) * 100) + 0.4 * g);
    const priceChangePct = q.changePct ?? null;

    return {
      ...r,
      // derived from ApeWisdom fields
      mentionChange: r.mentions_24h == null ? null : r.mentions - r.mentions_24h,
      upvotesPerMention: r.mentions > 0 ? Math.round(r.upvotes / r.mentions) : null,
      shareOfVoice: +((r.mentions / total) * 100).toFixed(1),
      heat,
      isNew: r.rankChange === 'new',
      // market enrichment (no key)
      price: q.price ?? null,
      priceChangePct,
      marketCap: q.marketCap ?? null,
      volume: q.volume ?? null,
      dayHigh: q.dayHigh ?? null,
      dayLow: q.dayLow ?? null,
      spark: q.spark || null,
      divergence: divergenceOf(r.changePct, priceChangePct),
    };
  });
}

// Resolve a ranking from the best available source:
//   1. your own Reddit OAuth pipeline (if credentials are configured)
//   2. ApeWisdom's free public API (real data, no auth) — the default
//   3. deterministic sample data (offline fallback)
async function compute(filterId, now) {
  const f = FILTERS[filterId];
  if (!f) throw new Error(`Unknown filter: ${filterId}`);

  let ranked = null;
  let source = null;

  // 1. Reddit OAuth — your independent pipeline.
  if (reddit.isConfigured()) {
    try {
      const docs = await reddit.fetchDocuments(f.subs);
      const rows = extractFromDocs(docs, f.type).slice(0, TOP_N);
      if (rows.length < 5) throw new Error('Too few tickers from Reddit');
      ranked = withDeltas(filterId, f.type, rows, now);
      source = 'reddit';
    } catch (e) {
      /* fall through */
    }
  }

  // 2. ApeWisdom public API — real, ApeWisdom-style data with no credentials.
  if (!ranked && apewisdom.hasFilter(filterId)) {
    try {
      ranked = await apewisdom.fetchRanking(filterId, TOP_N);
      seedApeHistory(filterId, f.type, ranked, now);
      source = 'apewisdom';
    } catch (e) {
      /* fall through */
    }
  }

  // 3. Deterministic sample data (offline fallback).
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
  ranked = await enrichRanking(ranked, f.type, now);
  snapshotIfDue(filterId, f.type, ranked, now);
  return pack(filterId, f, source, now, ranked);
}

async function getRanking(filterId, { force = false } = {}, now = Date.now()) {
  const cached = CACHE[filterId];
  if (!force && cached && now - cached.ts < CACHE_TTL_MS) return cached.payload;
  const payload = await compute(filterId, now);
  CACHE[filterId] = { ts: now, payload };
  return payload;
}

async function getDetail(filterId, ticker, now = Date.now()) {
  const f = FILTERS[filterId];
  if (!f) throw new Error(`Unknown filter: ${filterId}`);
  const sym = ticker.toUpperCase();
  const payload = await getRanking(filterId, {}, now);
  const row = payload.rows.find((r) => r.ticker === sym);
  const history = store.historyFor(filterId, f.type, sym);

  // Richer per-ticker market detail for the modal: a price-history sparkline
  // (Yahoo for stocks, CoinGecko for crypto) plus, for stocks, 52-wk range.
  let marketDetail = null;
  try {
    marketDetail = f.type === 'crypto' ? await market.getCryptoDetail(sym, now) : await market.getStockDetail(sym, now);
  } catch (_) {
    marketDetail = null;
  }

  return { filter: filterId, ticker: sym, row: row || null, history, marketDetail };
}

async function refreshAll(now = Date.now()) {
  const out = [];
  for (const id of Object.keys(FILTERS)) {
    try {
      out.push(await getRanking(id, { force: true }, now));
    } catch (e) {
      out.push({ filter: id, error: e.message });
    }
  }
  return out;
}

module.exports = { FILTERS, listFilters, getRanking, getDetail, refreshAll, extractFromDocs };
