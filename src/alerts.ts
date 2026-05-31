import * as store from './store';
import { FILTERS } from './aggregate';
import type { AssetType } from './types';

// Spike detector (Tier A).
//
// The mention source (ApeWisdom by default) reports a *rolling 24h* mention
// count refreshed ~hourly, so we cannot see literal "mentions in the last 15
// min". What we CAN see is the count *accelerating*: how fast the 24h total is
// climbing right now versus this ticker's own recent rhythm. That is the signal.
//
//   velocity = (mentions_now - mentions_lookback) / hours_elapsed   [mentions/hr]
//   baseline = median velocity over the trailing window
//   z        = (velocity - median) / (1.4826 * MAD + eps)
//
// MAD (median absolute deviation), not standard deviation, so the hourly-refresh
// sawtooth doesn't blow up the baseline. An alert fires only when the move is
// unusual (z), large in absolute terms (velocity floor — also the safety net
// when MAD is ~0), big relatively (% jump), and on a ticker with real volume of
// chatter (mentions floor). A per-ticker cooldown prevents repeat spam.

export interface AlertConfig {
  z: number; // min robust z-score
  minVel: number; // min mentions/hr added to the 24h window
  minMentions: number; // ignore tickers below this current mention count
  minPctJump: number; // min % rise over the lookback window
  lookbackMin: number; // velocity measurement window (minutes)
  baselineHours: number; // trailing window for the baseline distribution
  cooldownMin: number; // per-ticker silence after an alert
}

export function configFromEnv(): AlertConfig {
  const n = (v: string | undefined, d: number) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);
  return {
    z: n(process.env.ALERT_Z, 3),
    minVel: n(process.env.ALERT_MIN_VEL, 30),
    minMentions: n(process.env.ALERT_MIN_MENTIONS, 50),
    minPctJump: n(process.env.ALERT_MIN_PCT, 20),
    lookbackMin: n(process.env.ALERT_LOOKBACK_MIN, 60),
    baselineHours: n(process.env.ALERT_BASELINE_HOURS, 6),
    cooldownMin: n(process.env.ALERT_COOLDOWN_MIN, 90),
  };
}

export interface Alert {
  filter: string;
  type: AssetType;
  ticker: string;
  mentionsNow: number;
  mentionsPrev: number;
  pctJump: number;
  velocity: number; // mentions/hr
  z: number;
  priceChangePct: number | null;
  volRatio: number | null; // current volume / median baseline volume
  confirm: 'confirmed' | 'divergent' | 'unconfirmed';
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mad(xs: number[], med: number): number {
  if (xs.length === 0) return 0;
  return median(xs.map((x) => Math.abs(x - med)));
}

// Velocity at point i (mentions/hr) using the sample closest to lookbackMin
// before it. Returns null if no usable earlier sample exists.
function velocityAt(series: store.SeriesPoint[], i: number, lookbackMs: number): { vel: number; prevIdx: number } | null {
  const cur = series[i];
  if (cur.mentions == null) return null;
  const target = cur.ts - lookbackMs;
  let best = -1;
  let bestDist = Infinity;
  for (let j = i - 1; j >= 0; j--) {
    if (series[j].mentions == null) continue;
    const dist = Math.abs(series[j].ts - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = j;
    }
    if (series[j].ts <= target) break; // gone past the target, earlier points only get worse
  }
  if (best < 0) return null;
  const prev = series[best];
  const hours = (cur.ts - prev.ts) / 3_600_000;
  if (hours <= 0) return null;
  return { vel: ((cur.mentions as number) - (prev.mentions as number)) / hours, prevIdx: best };
}

function evaluateTicker(
  filter: string,
  type: AssetType,
  ticker: string,
  mentionsNow: number,
  cfg: AlertConfig,
  now: number
): Alert | null {
  const lookbackMs = cfg.lookbackMin * 60_000;
  const series = store.seriesSince(filter, type, ticker, now - cfg.baselineHours * 3_600_000);
  if (series.length < 4) return null; // not enough history to judge "unusual"

  const last = series.length - 1;
  const cur = velocityAt(series, last, lookbackMs);
  if (!cur) return null;

  // Baseline velocities at every prior point (exclude the current reading).
  const baseVels: number[] = [];
  for (let i = 1; i < last; i++) {
    const v = velocityAt(series, i, lookbackMs);
    if (v) baseVels.push(v.vel);
  }
  if (baseVels.length < 3) return null;

  const med = median(baseVels);
  const m = mad(baseVels, med);
  const z = (cur.vel - med) / (1.4826 * m + 1e-9);

  const prevPoint = series[cur.prevIdx];
  const mentionsPrev = prevPoint.mentions as number;
  const pctJump = mentionsPrev > 0 ? ((mentionsNow - mentionsPrev) / mentionsPrev) * 100 : Infinity;

  // Gates — ALL must hold.
  if (z < cfg.z) return null;
  if (cur.vel < cfg.minVel) return null;
  if (mentionsNow < cfg.minMentions) return null;
  if (pctJump < cfg.minPctJump) return null;

  // Confirmation: price move over the same window + volume vs its own baseline.
  const curPoint = series[last];
  let priceChangePct: number | null = null;
  if (curPoint.price != null && prevPoint.price != null && prevPoint.price > 0) {
    priceChangePct = ((curPoint.price - prevPoint.price) / prevPoint.price) * 100;
  }
  const baseVols = series.slice(0, last).map((p) => p.volume).filter((v): v is number => v != null && v > 0);
  let volRatio: number | null = null;
  if (curPoint.volume != null && curPoint.volume > 0 && baseVols.length >= 3) {
    const medVol = median(baseVols);
    if (medVol > 0) volRatio = curPoint.volume / medVol;
  }

  let confirm: Alert['confirm'] = 'unconfirmed';
  const priceUp = priceChangePct != null && priceChangePct >= 1;
  const priceDown = priceChangePct != null && priceChangePct <= -1;
  const volHot = volRatio != null && volRatio >= 2;
  if (priceUp || volHot) confirm = 'confirmed';
  else if (priceDown) confirm = 'divergent';

  return {
    filter,
    type,
    ticker,
    mentionsNow,
    mentionsPrev,
    pctJump: Math.round(pctJump),
    velocity: Math.round(cur.vel),
    z: +z.toFixed(1),
    priceChangePct: priceChangePct == null ? null : +priceChangePct.toFixed(1),
    volRatio: volRatio == null ? null : +volRatio.toFixed(1),
    confirm,
  };
}

// Evaluate every filter's latest snapshot. Applies the per-ticker cooldown and
// records alert state for the ones that fire. Returns alerts to be delivered.
export function evaluateAlerts(now: number = Date.now(), cfg: AlertConfig = configFromEnv()): Alert[] {
  const out: Alert[] = [];
  const cooldownMs = cfg.cooldownMin * 60_000;
  const seen = new Set<string>(); // de-dupe a ticker that trends across several filters

  for (const [filterId, f] of Object.entries(FILTERS)) {
    const latest = store.latestTickers(filterId, f.type);
    for (const row of latest) {
      if (row.mentions == null || row.mentions < cfg.minMentions) continue;
      const dedupeKey = `${f.type}:${row.ticker}`;
      if (seen.has(dedupeKey)) continue;

      const alert = evaluateTicker(filterId, f.type, row.ticker, row.mentions, cfg, now);
      if (!alert) continue;

      // Cooldown: stay quiet unless the spike is clearly stronger than last time.
      const prev = store.getAlertState(filterId, f.type, row.ticker);
      if (prev && now - prev.lastAlertTs < cooldownMs && alert.z < prev.lastScore * 1.5) continue;

      store.setAlertState(filterId, f.type, row.ticker, now, alert.z);
      seen.add(dedupeKey);
      out.push(alert);
    }
  }

  out.sort((a, b) => b.z - a.z);
  return out;
}
