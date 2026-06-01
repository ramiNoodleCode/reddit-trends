import * as store from './store';
import { FILTERS } from './aggregate';
import { evaluateSpikes, configFromEnv, type Alert, type AlertConfig, type TickerSnapshot } from './spike';

// Thin store adapter around the pure spike core (`spike.ts`). It gathers the
// latest snapshot + trailing series for every filter, hands them to
// `evaluateSpikes`, then persists cooldown state for whatever fired.
//
// A ticker's alert identity is (type, ticker), NOT (type, filter, ticker): the
// same stock spiking in `all-stocks` and `wallstreetbets` is one event. Cooldown
// state is therefore stored under a sentinel filter so a ticker can't dodge its
// own cooldown by surfacing from a different filter on a later collect.

export { configFromEnv };
export type { Alert, AlertConfig };

const COOLDOWN_FILTER = '__any__';

export function evaluateAlerts(now: number = Date.now(), cfg: AlertConfig = configFromEnv()): Alert[] {
  // Snapshots ordered by FILTERS (all-stocks first), so the preferred broad
  // filter wins when the same ticker qualifies in several.
  const snapshots: TickerSnapshot[] = [];
  for (const [filterId, f] of Object.entries(FILTERS)) {
    for (const row of store.latestTickers(filterId, f.type)) {
      if (row.mentions == null || row.mentions < cfg.minMentions) continue;
      const series = store.seriesSince(filterId, f.type, row.ticker, now - cfg.baselineHours * 3_600_000);
      snapshots.push({ filter: filterId, type: f.type, ticker: row.ticker, mentionsNow: row.mentions, series });
    }
  }

  const { alerts, stormSuppressed } = evaluateSpikes(
    snapshots,
    (type, ticker) => store.getAlertState(COOLDOWN_FILTER, type, ticker),
    now,
    cfg
  );

  if (stormSuppressed > 0) {
    console.log(`[${new Date(now).toISOString()}] alerts: suppressed ${stormSuppressed} candidates (market-wide refresh storm)`);
  }

  for (const a of alerts) store.setAlertState(COOLDOWN_FILTER, a.type, a.ticker, now, a.z);
  return alerts;
}
