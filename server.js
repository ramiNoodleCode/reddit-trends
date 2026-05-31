'use strict';

const path = require('path');
const express = require('express');
const agg = require('./src/aggregate');
const { isConfigured } = require('./src/reddit');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.static(path.join(__dirname, 'public')));

// List of available filter tabs (stocks + crypto).
app.get('/api/filters', (req, res) => {
  res.json({ filters: agg.listFilters() });
});

// Ranked trending tickers for a filter, e.g. /api/trending?filter=wallstreetbets
app.get('/api/trending', async (req, res) => {
  const filter = req.query.filter || 'all-stocks';
  const force = req.query.force === '1';
  try {
    const data = await agg.getRanking(filter, { force });
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Detail + mention history for a single ticker within a filter.
app.get('/api/ticker/:symbol', async (req, res) => {
  const filter = req.query.filter || 'all-stocks';
  try {
    const data = await agg.getDetail(filter, req.params.symbol);
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`reddit-trends running at http://localhost:${PORT}`);
  if (isConfigured()) {
    console.log('Data source: Reddit OAuth (your pipeline) → falls back to ApeWisdom, then sample data.');
  } else {
    console.log('Data source: ApeWisdom public API (live, no auth) → falls back to sample data if offline.');
    console.log('  Optional: add credentials.json to run your own Reddit OAuth pipeline instead.');
  }
});

// Refresh all filters in the background on a fixed interval so the cache and
// snapshot history stay warm even if nobody is browsing. Disable this when a
// separate collector (cron / systemd timer running collect.js) owns collection,
// by setting DISABLE_BACKGROUND_REFRESH=1.
if (process.env.DISABLE_BACKGROUND_REFRESH !== '1') {
  const REFRESH_MS = (Number(process.env.REFRESH_MIN) || 15) * 60 * 1000;
  setInterval(() => {
    agg.refreshAll().catch((e) => console.error('refresh error:', e.message));
  }, REFRESH_MS).unref();
}
