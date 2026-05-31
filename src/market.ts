import https from 'https';
import type { StockQuote, CryptoQuote, MarketDetail } from './types';

// Free, no-key market-data enrichment.
//   Stocks: Stooq batch CSV (price + day move + volume), plus a single Yahoo
//           v8 chart for the modal sparkline / 52-wk range.
//   Crypto: CoinGecko (price + 24h move + market cap + volume + history).
// All results are cached briefly; every call degrades to null on failure.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const TTL_MS = 5 * 60 * 1000;

function getText(url: string, ua: string = UA): Promise<string> {
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

async function getJSON<T = any>(url: string, ua: string = UA): Promise<T> {
  const body = await getText(url, ua);
  try {
    return JSON.parse(body) as T;
  } catch (e) {
    throw new Error(`Bad JSON: ${(e as Error).message}`);
  }
}

// Yahoo's chart endpoint rate-limits per User-Agent, so we hit it with a plain,
// lightweight UA kept separate from the heavier one used elsewhere.
const YAHOO_UA = 'Mozilla/5.0';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ---- caching ----------------------------------------------------------------
const cache = new Map<string, { ts: number; value: unknown }>();
function cached<T>(key: string, now: number): T | null {
  const c = cache.get(key);
  return c && now - c.ts < TTL_MS ? (c.value as T) : null;
}
function put<T>(key: string, value: T, now: number): T {
  cache.set(key, { ts: now, value });
  return value;
}

function num(x: string): number | null {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

// ---- stocks (Stooq batch CSV) ----------------------------------------------
export async function getStockQuotes(symbols: string[], now = Date.now()): Promise<Record<string, StockQuote>> {
  const out: Record<string, StockQuote> = {};
  const need: string[] = [];
  for (const s of symbols) {
    const hit = cached<StockQuote>(`stk:${s}`, now);
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
        out[ticker] = put<StockQuote>(`stk:${ticker}`, { price: c, changePct, volume: num(volume), dayHigh: num(high), dayLow: num(low) }, now);
      }
    } catch {
      /* leave this group unpriced */
    }
  }
  return out;
}

// On-demand richer detail for one stock (used by the modal). Yahoo's chart
// endpoint rate-limits in bursts but recovers quickly, so we retry across both
// edge hosts before giving up. Cached, so a modal re-open is free.
export async function getStockDetail(symbol: string, now = Date.now()): Promise<MarketDetail | null> {
  const key = `stkdet:${symbol}`;
  const hit = cached<MarketDetail>(key, now);
  if (hit) return hit;

  const hosts = ['query1', 'query2'];
  for (let i = 0; i < hosts.length; i++) {
    try {
      const j = await getJSON<any>(`https://${hosts[i]}.finance.yahoo.com/v8/finance/chart/${symbol}?range=1mo&interval=1d`, YAHOO_UA);
      const r = j.chart.result[0];
      const m = r.meta || {};
      const closes: number[] = ((r.indicators?.quote?.[0]?.close as (number | null)[]) || []).filter((x): x is number => typeof x === 'number');
      return put<MarketDetail>(
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
    } catch {
      if (i < hosts.length - 1) await delay(700); // brief backoff, then alt host
    }
  }
  return null;
}

// ---- crypto (CoinGecko) -----------------------------------------------------
// Curated symbol -> CoinGecko id map for the majors that dominate the crypto
// boards. Unmapped tickers simply go unpriced.
const COINGECKO_IDS: Record<string, string> = {
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

interface CoinGeckoPrice {
  usd?: number;
  usd_24h_change?: number;
  usd_market_cap?: number;
  usd_24h_vol?: number;
}

export async function getCryptoQuotes(symbols: string[], now = Date.now()): Promise<Record<string, CryptoQuote>> {
  const out: Record<string, CryptoQuote> = {};
  const idBySym: Record<string, string> = {};
  const ids: string[] = [];
  for (const s of symbols) {
    const id = COINGECKO_IDS[s];
    if (!id) continue;
    const hit = cached<CryptoQuote>(`cg:${s}`, now);
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
    const j = await getJSON<Record<string, CoinGeckoPrice>>(url);
    for (const id of Object.keys(j)) {
      const s = idBySym[id];
      const d = j[id];
      out[s] = put<CryptoQuote>(
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
  } catch {
    /* leave unpriced */
  }
  return out;
}

// On-demand price history for one coin (used by the modal price chart).
export async function getCryptoDetail(symbol: string, now = Date.now()): Promise<MarketDetail | null> {
  const id = COINGECKO_IDS[symbol];
  if (!id) return null;
  const key = `cgdet:${symbol}`;
  const hit = cached<MarketDetail>(key, now);
  if (hit) return hit;
  try {
    const j = await getJSON<{ prices?: [number, number][] }>(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=30&interval=daily`);
    const spark = (j.prices || []).map((p) => p[1]);
    return put<MarketDetail>(key, { spark }, now);
  } catch {
    return null;
  }
}
