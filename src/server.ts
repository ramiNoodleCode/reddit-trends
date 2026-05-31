import path from 'path';
import express, { Request, Response } from 'express';
import * as agg from './aggregate';
import { isConfigured } from './reddit';

const app = express();
const PORT = Number(process.env.PORT) || 4000;

// Compiled to dist/server.js, so static assets live one level up at ../public.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/filters', (_req: Request, res: Response) => {
  res.json({ filters: agg.listFilters() });
});

// Ranked trending tickers for a filter, e.g. /api/trending?filter=wallstreetbets
app.get('/api/trending', async (req: Request, res: Response) => {
  const filter = (req.query.filter as string) || 'all-stocks';
  const force = req.query.force === '1';
  try {
    res.json(await agg.getRanking(filter, { force }));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Detail + history for a single ticker within a filter.
app.get('/api/ticker/:symbol', async (req: Request, res: Response) => {
  const filter = (req.query.filter as string) || 'all-stocks';
  try {
    res.json(await agg.getDetail(filter, String(req.params.symbol)));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
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
    agg.refreshAll().catch((e: Error) => console.error('refresh error:', e.message));
  }, REFRESH_MS).unref();
}
