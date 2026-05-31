'use strict';

const { STOCKS, CRYPTO } = require('./tickers');

// Deterministic pseudo-random generator so mock data is stable within a run
// (and across the seeded history) instead of flickering on every request.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Build one ranking for a (type) with a per-symbol base popularity so the same
// names trend near the top across runs — just like the real site.
function buildRanking(type, seedSalt) {
  const dict = type === 'crypto' ? CRYPTO : STOCKS;
  const symbols = Object.keys(dict);
  const rows = symbols.map((sym) => {
    const rnd = mulberry32(hashStr(sym + ':' + seedSalt));
    // base popularity weight, heavy-tailed so a handful dominate
    const base = Math.pow(rnd(), 2.4);
    const mentions = Math.max(1, Math.round(base * 1400 + rnd() * 25));
    const upvotes = Math.round(mentions * (4 + rnd() * 30));
    const sentiment = +(rnd() * 1.6 - 0.6).toFixed(2); // skews mildly bullish
    return { ticker: sym, name: dict[sym], mentions, upvotes, sentiment };
  });
  rows.sort((a, b) => b.mentions - a.mentions);
  return rows;
}

// Given TODAY's ranking, derive a believable back-dated history so the engine
// can compute realistic 24h deltas and rank changes. Each ticker gets a stable
// per-symbol daily growth factor (mostly <1, i.e. trending up toward today),
// plus small per-day noise that nudges the ordering — exactly the kind of
// gentle churn the real ranking shows day to day.
function backdatedSnapshots(rows, now, days) {
  const snaps = [];
  for (let d = days; d >= 1; d--) {
    const ts = now - d * 24 * 3600 * 1000;
    const scaled = rows.map((r) => {
      const gb = 0.8 + mulberry32(hashStr(r.ticker + ':growth'))() * 0.28; // [0.80,1.08]
      const noise = 0.92 + mulberry32(hashStr(r.ticker + ':n' + d))() * 0.16; // [0.92,1.08]
      const f = Math.pow(gb, d) * noise;
      return {
        ticker: r.ticker,
        name: r.name,
        mentions: Math.max(1, Math.round(r.mentions * f)),
        upvotes: Math.round(r.upvotes * f),
        sentiment: r.sentiment,
      };
    });
    scaled.sort((a, b) => b.mentions - a.mentions);
    snaps.push({ ts, rows: scaled });
  }
  return snaps;
}

module.exports = { buildRanking, backdatedSnapshots };
