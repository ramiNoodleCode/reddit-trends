import type { AssetType } from './types';

// Pure spike-detection core (Tier A). No I/O — operates on plain in-memory data
// so it can be unit-tested without a database. `alerts.ts` is the thin adapter
// that feeds it snapshots from the store and persists cooldown state.
//
// The mention source (ApeWisdom by default) reports a *rolling 24h* mention
// count refreshed ~hourly, so we cannot see literal "mentions in the last 15
// min". What we CAN see is the count *accelerating*: how fast the 24h total is
// climbing right now versus this ticker's own recent rhythm.
//
//   velocity = (mentions_now - mentions_lookback) / hours_elapsed   [mentions/hr]
//   baseline = median velocity over the trailing window
//   z        = (velocity - median) / (1.4826 * MAD + scale_floor)
//
// MAD (median absolute deviation), not standard deviation, so the hourly-refresh
// sawtooth doesn't blow up the baseline. An alert fires only when the move is
// unusual (z), large in absolute terms (velocity floor — also the safety net
// when MAD is ~0), big relatively (% jump), and on a ticker with real volume of
// chatter (mentions floor). A per-ticker cooldown prevents repeat spam, and a
// storm guard drops whole batches when a refresh jolts the entire board at once.

export interface AlertConfig {
  z: number; // min robust z-score
  minVel: number; // min mentions/hr added to the 24h window
  minMentions: number; // ignore tickers below this current mention count
  minPctJump: number; // min % rise over the lookback window
  lookbackMin: number; // velocity measurement window (minutes)
  baselineHours: number; // trailing window for the baseline distribution
  cooldownMin: number; // per-ticker silence after an alert
  stormMax: number; // if more than this many tickers spike at once, treat as a refresh artifact and suppress
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
    stormMax: n(process.env.ALERT_STORM_MAX, 8),
  };
}

// A single point in a ticker's snapshot series, oldest-first when in an array.
export interface SeriesPoint {
  ts: number;
  mentions: number | null;
  price: number | null;
  volume: number | null;
}

// One ticker's current reading plus the trailing series the detector judges it against.
export interface TickerSnapshot {
  filter: string;
  type: AssetType;
  ticker: string;
  mentionsNow: number;
  series: SeriesPoint[];
}

export interface PriorAlert {
  lastAlertTs: number;
  lastScore: number;
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

export interface SpikeResult {
  alerts: Alert[];
  stormSuppressed: number; // count of candidates dropped because the whole board spiked at once
}

const Z_SCALE_FLOOR = 5; // min mentions/hr scale for the z denominator (guards MAD≈0)
const Z_CAP = 99; // cap reported z so a flat baseline can't show absurd values

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mad(xs: number[], med: number): number {
  if (xs.length === 0) return 0;
  return median(xs.map((x) => Math.abs(x - med)));
}

// Velocity at point i (mentions/hr) using the sample closest to lookbackMin
// before it. Returns null if no usable earlier sample exists.
function velocityAt(series: SeriesPoint[], i: number, lookbackMs: number): { vel: number; prevIdx: number } | null {
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

// Evaluate one ticker's series against the gates. Pure; returns an Alert or null.
export function evaluateOne(snap: TickerSnapshot, cfg: AlertConfig): Alert | null {
  const lookbackMs = cfg.lookbackMin * 60_000;
  const series = snap.series;
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
  // Robust z. When the baseline is dead flat (MAD≈0, e.g. a stablecoin's count
  // barely moves) a 1/eps denominator explodes z into the billions, which is
  // meaningless and spammy. Floor the scale at a few mentions/hr and cap the
  // result so z stays interpretable; the absolute floor gates remain the real
  // safety net.
  const scale = Math.max(1.4826 * m, Z_SCALE_FLOOR);
  const z = Math.min((cur.vel - med) / scale, Z_CAP);

  const prevPoint = series[cur.prevIdx];
  const mentionsPrev = prevPoint.mentions as number;
  const mentionsNow = snap.mentionsNow;
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
    filter: snap.filter,
    type: snap.type,
    ticker: snap.ticker,
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

// Evaluate a batch of ticker snapshots. `getPrior` supplies cooldown state keyed
// by (type, ticker) — a ticker's alert identity is its symbol, NOT the filter it
// surfaced from, so the same stock trending in `all-stocks` and `wallstreetbets`
// is one event. Snapshots should be ordered so the preferred filter (e.g. the
// broad aggregate) comes first; the first one that clears the gates wins.
export function evaluateSpikes(
  snapshots: TickerSnapshot[],
  getPrior: (type: AssetType, ticker: string) => PriorAlert | null,
  now: number,
  cfg: AlertConfig
): SpikeResult {
  const seen = new Set<string>(); // claim a ticker the moment it qualifies, across all filters
  const candidates: Alert[] = [];

  for (const snap of snapshots) {
    if (snap.mentionsNow < cfg.minMentions) continue;
    const key = `${snap.type}:${snap.ticker}`;
    if (seen.has(key)) continue;
    const alert = evaluateOne(snap, cfg);
    if (!alert) continue; // didn't spike in this filter; let another filter try the same ticker
    seen.add(key);
    candidates.push(alert);
  }

  // Storm guard: a market-wide refresh shift jolts the whole board's 24h counts
  // at once, so dozens of tickers "spike" simultaneously. Real news moves a
  // handful. If the batch is implausibly large, it's an artifact — suppress it
  // and don't record cooldown (so a genuine follow-up still alerts).
  if (candidates.length > cfg.stormMax) {
    return { alerts: [], stormSuppressed: candidates.length };
  }

  const cooldownMs = cfg.cooldownMin * 60_000;
  const out: Alert[] = [];
  for (const alert of candidates) {
    const prev = getPrior(alert.type, alert.ticker);
    // Stay quiet during cooldown unless the spike is clearly stronger than last time.
    if (prev && now - prev.lastAlertTs < cooldownMs && alert.z < prev.lastScore * 1.5) continue;
    out.push(alert);
  }

  out.sort((a, b) => b.z - a.z);
  return { alerts: out, stormSuppressed: 0 };
}
