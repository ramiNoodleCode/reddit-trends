import * as agg from './aggregate';
import type { RankingPayload } from './types';

// Standalone snapshot collector for cron / systemd timers.
//
// Runs exactly one refresh of every filter — fetching mentions + price and
// writing a snapshot row per ticker into SQLite — then exits. It does NOT start
// the web server, so it's safe to run on a schedule independently of the UI.
//
//   node dist/collect.js
//
// Exit code 0 on success (at least one filter collected), 1 on total failure.

function isError(r: RankingPayload | { filter: string; error: string }): r is { filter: string; error: string } {
  return 'error' in r;
}

(async () => {
  const start = Date.now();
  const stamp = () => new Date().toISOString();
  try {
    const results = await agg.refreshAll();
    const failed = results.filter(isError);
    const ok = results.filter((r): r is RankingPayload => !isError(r));
    const tickers = ok.reduce((n, r) => n + (r.count || 0), 0);
    console.log(
      `[${stamp()}] collected ${ok.length}/${results.length} filters, ${tickers} ticker rows, ` +
        `in ${Date.now() - start}ms` +
        (failed.length ? ` — failed: ${failed.map((f) => `${f.filter} (${f.error})`).join('; ')}` : '')
    );
    process.exit(failed.length === results.length ? 1 : 0);
  } catch (e) {
    console.error(`[${stamp()}] collect failed:`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
})();
