'use strict';

const https = require('https');

// ApeWisdom publishes a free, no-auth public API with exactly the mention/rank
// data we want. Using it as a live source gives real, ApeWisdom-style numbers
// with zero Reddit credentials. (The Reddit-OAuth path remains available for
// running your own independent pipeline later.)
//
// Endpoint: https://apewisdom.io/api/v1.0/filter/{slug}/page/{n}
// Fields per result: rank, ticker, name, mentions, upvotes,
//                    rank_24h_ago, mentions_24h_ago
// Note: no sentiment field is exposed, so sentiment shows as N/A for this source.

const UA = 'reddit-trends/0.1 (ApeWisdom API client)';

// Our internal filter id -> ApeWisdom slug. Validated against the live API.
const SLUG = {
  'all-stocks': 'all-stocks',
  wallstreetbets: 'wallstreetbets',
  stocks: 'stocks',
  stockmarket: 'stockmarket',
  investing: 'investing',
  options: 'options',
  'all-crypto': 'all-crypto',
  CryptoCurrency: 'CryptoCurrency',
  SatoshiStreetBets: 'SatoshiStreetBets',
  CryptoMoonShots: 'CryptoMoonShots',
  Bitcoin: 'Bitcoin',
  ethereum: 'ethereum',
};

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Bad JSON from ${url}: ${e.message}`));
        }
      });
    });
    req.setTimeout(12000, () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on('error', reject);
  });
}

function hasFilter(filterId) {
  return Boolean(SLUG[filterId]);
}

// Fetch and map one filter's ranking into our row schema (already including
// 24h deltas straight from the API — no snapshot history required).
async function fetchRanking(filterId, topN = 100) {
  const slug = SLUG[filterId];
  if (!slug) throw new Error(`No ApeWisdom slug for filter ${filterId}`);

  const json = await getJSON(`https://apewisdom.io/api/v1.0/filter/${slug}/page/1`);
  const results = (json.results || []).slice(0, topN);
  if (results.length === 0) throw new Error(`ApeWisdom returned no rows for ${slug}`);

  return results.map((r) => {
    const m24 = r.mentions_24h_ago;
    const change = m24 == null ? null : r.mentions - m24;
    const changePct = m24 && m24 > 0 ? Math.round((change / m24) * 100) : null;
    let rankChange = null;
    if (r.rank_24h_ago == null) rankChange = 'new';
    else rankChange = r.rank_24h_ago - r.rank; // positive = climbed

    return {
      rank: r.rank,
      ticker: String(r.ticker).replace(/\.X$/, ''), // strip ApeWisdom crypto suffix
      name: r.name || '',
      mentions: r.mentions,
      mentions_24h: m24 == null ? null : m24,
      changePct,
      upvotes: r.upvotes,
      rankChange,
      sentiment: null,
      sentimentLabel: 'N/A',
    };
  });
}

module.exports = { fetchRanking, hasFilter, SLUG };
