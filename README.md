# RedditTrends

An [ApeWisdom](https://apewisdom.io/)-style tracker for the stock and crypto
tickers being talked about most on Reddit. It scrapes public Reddit listings,
extracts ticker mentions, ranks them, and shows 24-hour mention/rank movement
and a rough sentiment read — with per-ticker mention-history charts.

## Features

- **Ranked trending table** — rank, 24h rank change (▲/▼/NEW), ticker, mentions,
  24h % change, upvotes, **live price**, **day %**, and a **Heat** momentum bar.
- **Market enrichment (no API key)** — price/day-move/volume for stocks (Stooq)
  and price/24h-move/market-cap for crypto (CoinGecko), joined per ticker.
- **Divergence signal** — a per-row flag for when mentions and price disagree
  (Hype = chatter up + price down, Fade = chatter down + price up, Aligned, Mixed).
- **Derived metrics** — share-of-voice, upvotes/mention, mention change, Heat.
- **Sortable columns + a "Sort by" control** (covers metrics not shown as columns:
  share-of-voice, volume, market cap, …) and **pagination** (25/page).
- **Stocks & Crypto tabs** with subreddit filters (wallstreetbets, stocks,
  CryptoCurrency, SatoshiStreetBets, …).
- **Ticker detail** — click any row for ~12 stats plus Mentions & Price charts.
- **Live search**, and **persisted snapshot history** for 24h deltas / charts.

## Run it

Requires **Node 18+** (for the prebuilt `better-sqlite3` binary; an `.nvmrc`
pins Node 20).

```bash
cd reddit-trends
nvm use            # picks up .nvmrc (Node 20)
npm install
npm start          # serves http://localhost:4000
```

Open <http://localhost:4000>.

## How it works

```
src/types.ts      shared domain types
src/apewisdom.ts  ApeWisdom public-API client (default mention source)
src/market.ts     price enrichment — Stooq (stocks) + CoinGecko (crypto), no key
src/reddit.ts     Reddit OAuth client → oauth.reddit.com (optional pipeline)
src/config.ts     load Reddit app credentials (env or credentials.json)
src/tickers.ts    curated stock + crypto symbol dictionaries, slang blacklist
src/aggregate.ts  source selection, extract/rank/deltas, enrichment, snapshots
src/sentiment.ts  lightweight bullish/bearish lexicon scorer (Reddit path)
src/store.ts      SQLite snapshot store (better-sqlite3): history, 24h lookups,
                  per-ticker charts; schema includes price; 30-day retention
src/mock.ts       deterministic sample data + back-dated history
src/server.ts     Express server + JSON API
src/collect.ts    standalone collector (cron / systemd)
src/client/app.ts browser UI (compiled to public/app.js); Chart.js via CDN
public/           index.html + styles.css + compiled app.js
dist/             compiled backend JS (build output; gitignored)
data/trends.db    the SQLite database (gitignored; auto-created on first run)
```

Written in **TypeScript**: `npm run build` compiles the backend to `dist/` and the
browser client to `public/app.js` (`npm install` runs this automatically via the
`prepare` script).

**Ticker extraction** matches `$CASHTAGS` and bare uppercase symbols against a
known-symbol dictionary, with a slang blacklist (`DD`, `YOLO`, `CEO`, `ETF`, …)
so common words don't masquerade as tickers. Each post/comment counts once per
ticker; upvotes and a sentiment score accumulate per symbol.

### Data sources (auto-selected, in priority order)

The engine picks the best available source per request:

1. **Reddit OAuth** — your own pipeline, used **if** `credentials.json` is present
   (see below). Most flexible/independent.
2. **ApeWisdom public API** — `https://apewisdom.io/api/v1.0/...`, free and
   **no auth/registration**. This is the **default** and gives real,
   ApeWisdom-style numbers out of the box. (No sentiment field, so that column
   shows `N/A` for this source.)
3. **Sample data** — deterministic offline fallback so the UI is never empty.

**Price enrichment** (independent of the mention source): stocks via **Stooq**
batch CSV, crypto via **CoinGecko** — both free, no key, cached 5 min. Notes:
the stock *day %* is the intraday open→close move (Stooq's batch endpoint
doesn't carry previous close), and the modal's 52-week range comes from Yahoo's
unofficial chart endpoint, which can rate-limit (it degrades to `–`). Everything
fails soft: an unreachable price source just leaves those cells blank.

The active source is shown under the table and logged at startup. So **live data
works with zero setup** via ApeWisdom; the Reddit OAuth path below is optional,
for when you want to run your own independent ingestion.

> Why not scrape Reddit directly? Reddit blocks **unauthenticated** `.json`
> scraping by IP reputation (403 bot page — common from CGNAT/shared ISPs like
> Starlink). And as of 2024+, even creating an OAuth app routes non-commercial
> Data API use through a **registration request form**
> (`support.reddithelp.com/.../requests/new?ticket_form_id=14868593862164`).
> ApeWisdom's API sidesteps all of that for a prototype.

## Optional: run your own Reddit OAuth pipeline

One-time setup. Uses the userless `client_credentials` grant, so it
**never needs your Reddit password** — only an app client id + secret. Note this
now requires completing Reddit's Data API registration (see box above).

1. Log in to Reddit and open <https://www.reddit.com/prefs/apps>.
2. Click **"are you a developer? create an app…"** at the bottom.
3. Fill in:
   - **name:** `reddit-trends` (anything)
   - **type:** select **"script"**
   - **redirect uri:** `http://localhost:4000` (required but unused)
4. Click **create app**. You'll now see:
   - the **client id** — the short string just under "personal use script"
   - the **secret** — labeled `secret`
5. Copy `credentials.example.json` → `credentials.json` and paste both values
   (or set `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` env vars). `credentials.json`
   is gitignored.
6. Restart: `npm start`. You should see
   `Reddit OAuth: configured → using live data`.

Free tier allows ~100 requests/minute — far more than this app needs.

## Extending it

- **Reddit OAuth** — ✅ implemented (`src/reddit.js` + `src/config.js`). See
  "Getting live data" above to switch from sample data to live.
- **Real-time price/market data** — join each ticker to a quotes API.
- **Better sentiment** — replace the lexicon in `src/sentiment.js` with a model.
- **Persistence** — ✅ SQLite (`src/store.js`). Next: a standalone collector on a
  scheduler so history accrues even when the web app is closed; Postgres/Timescale
  for multi-instance.
- **More tabs** — add subreddits/filters in the `FILTERS` map in `src/aggregate.js`.
- **Scheduled collection** — ✅ a standalone `collect.js` runs one refresh and
  exits, for cron / systemd timers. See **[DEPLOY.md](DEPLOY.md)** for the
  Raspberry-Pi walkthrough. The web server also self-collects every 15 min
  (disable with `DISABLE_BACKGROUND_REFRESH=1` when a timer owns collection).

Not investment advice.
