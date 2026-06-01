import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateOne,
  evaluateSpikes,
  median,
  mad,
  type AlertConfig,
  type TickerSnapshot,
  type SeriesPoint,
  type PriorAlert,
} from './spike';
import type { AssetType } from './types';

const HOUR = 3_600_000;

const cfg: AlertConfig = {
  z: 3,
  minVel: 30,
  minMentions: 50,
  minPctJump: 20,
  lookbackMin: 60,
  baselineHours: 6,
  cooldownMin: 90,
  stormMax: 8,
};

// Build a snapshot whose series is `mentions` (oldest-first), spaced one hour
// apart so each lookback (60 min) lands on the immediately preceding point and
// velocity == the mention delta. The last point sits at `now`.
function snap(ticker: string, filter: string, mentions: number[], now: number, type: AssetType = 'stocks'): TickerSnapshot {
  const n = mentions.length;
  const series: SeriesPoint[] = mentions.map((m, i) => ({
    ts: now - (n - 1 - i) * HOUR,
    mentions: m,
    price: null,
    volume: null,
  }));
  return { filter, type, ticker, mentionsNow: mentions[n - 1], series };
}

const noPrior = () => null;

test('median and mad', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), 0);
  assert.equal(mad([10, 10, 10, 10], 10), 0);
});

test('a clear acceleration fires an alert', () => {
  // flat baseline velocity of 10/hr, then a 200/hr jump
  const s = snap('GME', 'all-stocks', [100, 110, 120, 130, 140, 150, 350], 1_000 * HOUR);
  const a = evaluateOne(s, cfg);
  assert.ok(a, 'expected an alert');
  assert.equal(a!.ticker, 'GME');
  assert.equal(a!.velocity, 200);
  assert.ok(a!.z >= cfg.z);
});

test('too little history yields no alert', () => {
  const s = snap('AMC', 'all-stocks', [100, 200, 600], 1_000 * HOUR); // 3 points < 4
  assert.equal(evaluateOne(s, cfg), null);
});

test('flat baseline (MAD~0) caps z instead of exploding', () => {
  // baseline velocity is dead flat (MAD=0); a huge final jump would drive raw z
  // into the thousands without the scale floor + cap.
  const s = snap('FLAT', 'all-stocks', [100, 110, 120, 130, 140, 150, 750], 1_000 * HOUR);
  const a = evaluateOne(s, cfg);
  assert.ok(a, 'expected an alert');
  assert.ok(a!.z <= 99, `z should be capped at 99, got ${a!.z}`);
  assert.ok(a!.z > 0);
});

test('cross-filter dedupe: same ticker in two filters is one alert', () => {
  const now = 1_000 * HOUR;
  const snapshots = [
    snap('IBM', 'all-stocks', [100, 110, 120, 130, 140, 150, 350], now),
    snap('IBM', 'wallstreetbets', [100, 110, 120, 130, 140, 150, 360], now),
  ];
  const { alerts } = evaluateSpikes(snapshots, noPrior, now, cfg);
  assert.equal(alerts.length, 1, 'the same ticker across filters must collapse to one alert');
  assert.equal(alerts[0].filter, 'all-stocks', 'the first (preferred) filter should win');
});

test('storm guard suppresses a market-wide refresh spike', () => {
  const now = 1_000 * HOUR;
  // stormMax = 8; produce 9 distinct tickers that all spike at once.
  const snapshots: TickerSnapshot[] = [];
  for (let i = 0; i < 9; i++) {
    snapshots.push(snap(`T${i}`, 'all-stocks', [100, 110, 120, 130, 140, 150, 350], now));
  }
  const { alerts, stormSuppressed } = evaluateSpikes(snapshots, noPrior, now, cfg);
  assert.equal(alerts.length, 0, 'a storm should produce no alerts');
  assert.equal(stormSuppressed, 9);
});

test('a handful of simultaneous spikes is NOT a storm', () => {
  const now = 1_000 * HOUR;
  const snapshots: TickerSnapshot[] = [];
  for (let i = 0; i < 3; i++) {
    snapshots.push(snap(`R${i}`, 'all-stocks', [100, 110, 120, 130, 140, 150, 350], now));
  }
  const { alerts, stormSuppressed } = evaluateSpikes(snapshots, noPrior, now, cfg);
  assert.equal(alerts.length, 3);
  assert.equal(stormSuppressed, 0);
});

test('cooldown silences a repeat unless clearly stronger', () => {
  const now = 1_000 * HOUR;
  const s = snap('TSLA', 'all-stocks', [100, 110, 120, 130, 140, 150, 350], now); // z ~ 38
  const recentSameStrength: PriorAlert = { lastAlertTs: now - 30 * 60_000, lastScore: 38 };
  const r1 = evaluateSpikes([s], () => recentSameStrength, now, cfg);
  assert.equal(r1.alerts.length, 0, 'within cooldown and not 1.5x stronger -> suppressed');

  // A spike that IS clearly stronger breaks through.
  const big = snap('TSLA', 'all-stocks', [100, 110, 120, 130, 140, 150, 750], now); // z capped 99
  const r2 = evaluateSpikes([big], () => recentSameStrength, now, cfg);
  assert.equal(r2.alerts.length, 1, '>=1.5x stronger -> fires through cooldown');

  // Past the cooldown window, even an equal-strength spike fires.
  const old: PriorAlert = { lastAlertTs: now - 120 * 60_000, lastScore: 38 };
  const r3 = evaluateSpikes([s], () => old, now, cfg);
  assert.equal(r3.alerts.length, 1, 'after cooldown -> fires');
});

test('mentions floor gates low-chatter tickers', () => {
  const now = 1_000 * HOUR;
  // Same acceleration shape but absolute counts well under minMentions (50).
  const s = snap('TINY', 'all-stocks', [1, 2, 3, 4, 5, 6, 40], now);
  const { alerts } = evaluateSpikes([s], noPrior, now, cfg);
  assert.equal(alerts.length, 0);
});

test('confirmation reflects price/volume', () => {
  const now = 1_000 * HOUR;
  const s = snap('NVDA', 'all-stocks', [100, 110, 120, 130, 140, 150, 350], now);
  // Add a strong price rise over the lookback window on the last two points.
  s.series[s.series.length - 2].price = 100;
  s.series[s.series.length - 1].price = 105;
  const a = evaluateOne(s, cfg);
  assert.ok(a);
  assert.equal(a!.confirm, 'confirmed');
  assert.equal(a!.priceChangePct, 5);
});
