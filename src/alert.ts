import { deliverAlerts } from './deliver';

// Standalone alert pass: evaluate spikes against the current DB and post any to
// Telegram. Assumes a collector has already written the latest snapshot. Mostly
// useful for manual runs / debugging — in production the watcher (watch.js)
// triggers delivery right after it detects a fresh ApeWisdom refresh.
//
//   node dist/alert.js

(async () => {
  try {
    console.log(await deliverAlerts());
  } catch (e) {
    console.error('alert pass failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
  process.exit(0);
})();
