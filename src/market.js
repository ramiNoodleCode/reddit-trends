'use strict';

const https = require('https');

// Free, no-key market-data enrichment.
//   Stocks: Yahoo Finance batch "spark" endpoint (price + day move + sparkline),
//           plus a single per-symbol v8 chart for the detail modal.
//   Crypto: CoinGecko simple/price (price + 24h move + market cap + volume).
// All results are cached briefly. Yahoo's endpoints are unofficial and may
// rate-limit; every call degrades gracefully to null fields on failure.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const TTL_MS = 5 * 60 * 1000;

function getText(url, ua = UA) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': ua, Accept: '*/*' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.setTimeout(12000, () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on('error', reject);
  });
}

async function getJSON(url, ua = UA) {
  const body = await getText(url, ua);
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`Bad JSON: ${e.message}`);
  }
}

// Yahoo's chart endpoint rate-limits per User-Agent, so we hit it with a plain,
// lightweight UA kept separate from the heavier one used elsewhere.
const YAHOO_UA = 'Mozilla/5.0';

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ---- caching ----------------------------------------------------------------
const cache = new Map(); // key -> { ts, value }
function cached(key, now) {
  const c = cache.get(key);
  return c && now - c.ts < TTL_MS ? c.value : null;
}
function put(key, value, now) {
  cache.set(key, { ts: now, value });
  return value;
}

// ---- stocks (Stooq batch CSV) ----------------------------------------------
// Stooq's light quote endpoint is batchable, key-free, and not aggressively
// rate-limited (Yahoo's spark endpoint 429s under load). It returns the latest
// session's OHLCV; we report Close as price and the intraday open->close move as
// the day change. Unknown tickers come back as "N/D" and are simply skipped.

function num(x) {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

async function getStockQuotes(symbols, now = Date.now()) {
  const out = {};
  const need = [];
  for (const s of symbols) {
    const hit = cached(`stk:${s}`, now);
    if (hit) out[s] = hit;
    else need.push(s);
  }
  if (need.length === 0) return out;

  for (const group of chunk(need, 50)) {
    try {
      const list = group.map((s) => `${s.toLowerCase()}.us`).join('+');
      const csv = await getText(`https://stooq.com/q/l/?s=${list}&f=sd2t2ohlcv&h&e=csv`);
      const lines = csv.trim().split('\n').slice(1); // drop header
      for (const line of lines) {
        const [sym, date, , open, high, low, close, volume] = line.split(',');
        if (!sym || date === 'N/D') continue;
        const ticker = sym.replace(/\.US$/i, '');
        const o = num(open);
        const c = num(close);
        const changePct = o && c != null ? +(((c - o) / o) * 100).toFixed(2) : null;
        out[ticker] = put(
          `stk:${ticker}`,
          { price: c, changePct, volume: num(volume), dayHigh: num(high), dayLow: num(low) },
          now
        );
      }
    } catch (_) {
      /* leave this group unpriced */
    }
  }
  return out;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// On-demand richer detail for one stock (used by the modal). Yahoo's chart
// endpoint rate-limits in bursts but recovers quickly, so we retry across both
// edge hosts before giving up. Cached, so a modal re-open is free.
async function getStockDetail(symbol, now = Date.now()) {
  const key = `stkdet:${symbol}`;
  const hit = cached(key, now);
  if (hit) return hit;

  const hosts = ['query1', 'query2'];
  for (let i = 0; i < hosts.length; i++) {
    try {
      const j = await getJSON(`https://${hosts[i]}.finance.yahoo.com/v8/finance/chart/${symbol}?range=1mo&interval=1d`, YAHOO_UA);
      const r = j.chart.result[0];
      const m = r.meta || {};
      const closes = ((r.indicators && r.indicators.quote && r.indicators.quote[0].close) || []).filter((x) => typeof x === 'number');
      return put(
        key,
        {
          price: m.regularMarketPrice ?? null,
          dayHigh: m.regularMarketDayHigh ?? null,
          dayLow: m.regularMarketDayLow ?? null,
          wk52High: m.fiftyTwoWeekHigh ?? null,
          wk52Low: m.fiftyTwoWeekLow ?? null,
          volume: m.regularMarketVolume ?? null,
          currency: m.currency || 'USD',
          exchange: m.fullExchangeName || '',
          spark: closes,
        },
        now
      );
    } catch (_) {
      if (i < hosts.length - 1) await delay(700); // brief backoff, then alt host
    }
  }
  return null;
}

// ---- crypto (CoinGecko) -----------------------------------------------------

// Curated symbol -> CoinGecko id map for the majors that dominate the crypto
// boards. Unmapped tickers simply go unpriced.
const COINGECKO_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple', ADA: 'cardano',
  DOGE: 'dogecoin', SHIB: 'shiba-inu', DOT: 'polkadot', MATIC: 'matic-network',
  LTC: 'litecoin', LINK: 'chainlink', AVAX: 'avalanche-2', UNI: 'uniswap',
  ATOM: 'cosmos', XLM: 'stellar', ALGO: 'algorand', VET: 'vechain',
  FIL: 'filecoin', TRX: 'tron', ETC: 'ethereum-classic', BCH: 'bitcoin-cash',
  NEAR: 'near', APE: 'apecoin', SAND: 'the-sandbox', MANA: 'decentraland',
  AAVE: 'aave', GRT: 'the-graph', FTM: 'fantom', XMR: 'monero', EOS: 'eos',
  PEPE: 'pepe', BONK: 'bonk', WIF: 'dogwifcoin', ARB: 'arbitrum',
  OP: 'optimism', INJ: 'injective-protocol', SUI: 'sui', TON: 'the-open-network',
  RNDR: 'render-token', FET: 'fetch-ai', TIA: 'celestia', USDT: 'tether',
  USDC: 'usd-coin', BNB: 'binancecoin', CRO: 'crypto-com-chain',
};

async function getCryptoQuotes(symbols, now = Date.now()) {
  const out = {};
  const idBySym = {};
  const ids = [];
  for (const s of symbols) {
    const id = COINGECKO_IDS[s];
    if (!id) continue;
    const hit = cached(`cg:${s}`, now);
    if (hit) out[s] = hit;
    else {
      idBySym[id] = s;
      ids.push(id);
    }
  }
  if (ids.length === 0) return out;

  try {
    const url =
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}` +
      `&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`;
    const j = await getJSON(url);
    for (const id of Object.keys(j)) {
      const s = idBySym[id];
      const d = j[id];
      out[s] = put(
        `cg:${s}`,
        {
          price: d.usd ?? null,
          changePct: d.usd_24h_change != null ? +d.usd_24h_change.toFixed(2) : null,
          marketCap: d.usd_market_cap ?? null,
          volume: d.usd_24h_vol ?? null,
        },
        now
      );
    }
  } catch (_) {
    /* leave unpriced */
  }
  return out;
}

// On-demand price history for one coin (used by the modal price chart).
async function getCryptoDetail(symbol, now = Date.now()) {
  const id = COINGECKO_IDS[symbol];
  if (!id) return null;
  const key = `cgdet:${symbol}`;
  const hit = cached(key, now);
  if (hit) return hit;
  try {
    const j = await getJSON(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=30&interval=daily`);
    const spark = (j.prices || []).map((p) => p[1]);
    return put(key, { spark }, now);
  } catch (_) {
    return null;
  }
}

module.exports = { getStockQuotes, getCryptoQuotes, getStockDetail, getCryptoDetail };
