import * as apewisdom from './apewisdom';
import * as agg from './aggregate';
import * as store from './store';
import { deliverAlerts } from './deliver';

// ApeWisdom refresh watcher.
//
// ApeWisdom recomputes its rolling 24h mention counts roughly hourly, but
// exposes no "last updated" timestamp (Cloudflare serves it DYNAMIC). So rather
// than poll on a blind schedule, we run this cheaply every few minutes: fetch
// two bellwether filters, fingerprint them, and compare to the last reading.
// The numbers only move when ApeWisdom has actually refreshed — so the instant
// the fingerprint changes we do the full collect (all filters + price) and run
// the spike alerter. Result: fresh data lands within one poll of every refresh,
// whatever time in the hour it happens, with no duplicate snapshots in between.
//
//   node dist/watch.js

const BELLWETHERS = ['all-stocks', 'all-crypto'];

// A compact, refresh-sensitive fingerprint: top-25 ticker:mentions pairs.
async function fingerprint(filterId: string): Promise<string | null> {
  try {
    const rows = await apewisdom.fetchRanking(filterId, 25);
    return JSON.stringify(rows.map((r) => [r.ticker, r.mentions]));
  } catch {
    return null; // network blip — treat as "no reading", don't clobber state
  }
}

(async () => {
  const now = Date.now();
  const stamp = () => new Date().toISOString();

  const prints = await Promise.all(BELLWETHERS.map(fingerprint));

  let changed = false;
  let reachable = false;
  BELLWETHERS.forEach((id, i) => {
    const cur = prints[i];
    if (cur == null) return; // unreachable this tick
    reachable = true;
    const key = `fp:${id}`;
    if (store.getMeta(key) !== cur) {
      changed = true;
      store.setMeta(key, cur);
    }
  });

  if (!reachable) {
    console.log(`[${stamp()}] watch: ApeWisdom unreachable, skipping`);
    process.exit(0);
  }
  if (!changed) {
    console.log(`[${stamp()}] watch: no refresh detected, skipping`);
    process.exit(0);
  }

  // Fresh data — do the real work.
  const start = Date.now();
  const results = await agg.refreshAll(now);
  const ok = results.filter((r) => !('error' in r)).length;
  console.log(`[${stamp()}] watch: refresh detected → collected ${ok}/${results.length} filters in ${Date.now() - start}ms`);

  try {
    console.log(await deliverAlerts(now));
  } catch (e) {
    console.error(`[${stamp()}] watch: alert delivery failed:`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
  process.exit(0);
})();
