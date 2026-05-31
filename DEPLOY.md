# Deploying on a Raspberry Pi

Goal: keep a SQLite history accruing 24/7 by running the **collector** on a
schedule. Optionally also serve the web UI. Two scheduling options are provided:
**systemd timer (recommended)** or **cron**.

## 0. Prerequisites on the Pi

- **Node 18+** (Node 20 recommended; matches `.nvmrc`). Either:
  - nvm: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash` then `nvm install 20`, or
  - NodeSource: `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs`
- `git`, and a C toolchain only as a fallback: `sudo apt-get install -y git python3 build-essential`
  (`better-sqlite3` ships prebuilt binaries for `linux-arm64`/`armv7`; the
  toolchain is only needed if no prebuilt matches your Pi/Node.)

## 1. Clone and install

```bash
cd ~
git clone https://github.com/<your-username>/reddit-trends.git
cd reddit-trends
nvm use            # or ensure `node -v` is 18+
npm install        # installs deps, builds better-sqlite3 for the Pi's arch,
                   # and compiles TypeScript → dist/ (via the prepare script)
```

> The app is TypeScript. `npm install` auto-runs `npm run build` (the `prepare`
> script), producing `dist/` and `public/app.js`. To rebuild manually after code
> changes: `npm run build`.

## 2. Smoke-test the collector

```bash
npm run collect          # = node dist/collect.js
# → [2026-...Z] collected 12/12 filters, 1100 ticker rows, in 1840ms
ls -lh data/trends.db    # the SQLite database now exists
```

If that prints a collected line and `data/trends.db` appears, you're ready to
schedule it.

The scheduled unit actually runs `dist/watch.js`, not `collect.js`. The watcher
is cheaper: it checks whether ApeWisdom has refreshed, and only does the full
collect (plus any spike alerts) when the data has actually changed. That keeps
the history phase-locked to ApeWisdom's roughly hourly refresh without storing
duplicate snapshots. You can smoke-test it the same way:

```bash
node dist/watch.js       # fingerprints, collects only if changed, then alerts
```

## 3a. Schedule with a systemd timer (recommended)

More robust than cron: survives reboots, logs to journald, easy status checks.
The timer fires every 5 minutes and runs the watcher, so fresh data lands within
about 5 minutes of each ApeWisdom refresh.

```bash
# Find your absolute node path (cron/systemd need it, not the `node` alias):
which node                    # e.g. /usr/bin/node or /home/pi/.nvm/.../bin/node

# Edit the unit files in deploy/ to set User, WorkingDirectory, and ExecStart
# (the node path above), then install them:
sudo cp deploy/reddit-trends-collect.service /etc/systemd/system/
sudo cp deploy/reddit-trends-collect.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now reddit-trends-collect.timer

# Verify:
systemctl list-timers reddit-trends-collect.timer
journalctl -u reddit-trends-collect.service --since "1 hour ago"
```

If you want Telegram spike alerts, set them up before installing the service
(see "5. (Optional) Telegram spike alerts" below); the service reads its config
from `alert.env`.

## 3b. Or schedule with cron

```bash
crontab -e
# add (every 30 min). The wrapper handles cd + PATH + nvm:
*/30 * * * * /home/pi/reddit-trends/scripts/collect.sh >> /home/pi/reddit-trends/data/collect.log 2>&1
```

Check `data/collect.log` after the next half-hour tick.

> Snapshot spacing is gated by `SNAPSHOT_MIN_GAP_MIN` (default 30 min). Keep your
> schedule interval ≥ that value, or lower the env var to match a tighter cadence.

## 4. (Optional) Serve the web UI

```bash
# Edit deploy/reddit-trends-web.service (User / WorkingDirectory / node path), then:
sudo cp deploy/reddit-trends-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now reddit-trends-web.service
# UI at http://<pi-ip>:4000
```

The web service sets `DISABLE_BACKGROUND_REFRESH=1` so collection stays owned by
the timer/cron (no double-collecting).

## 5. (Optional) Telegram spike alerts

The watcher can message you on Telegram when a ticker's mention count suddenly
accelerates. Detection is honest about its resolution: ApeWisdom is a rolling
24h count refreshed about hourly, so this catches acceleration over roughly an
hour, not literal 15-minute bursts. Each alert is tagged with whether price and
volume confirm the move.

Create a `alert.env` file next to the app (it is gitignored, keep it private)
and fill in your own values:

```bash
# Telegram delivery
TELEGRAM_BOT_TOKEN=123456:your-bot-token
TELEGRAM_CHAT_ID=-1001234567890        # group or channel id
TELEGRAM_THREAD_ID=1758                # optional: a forum topic id

# How often a new snapshot may be written (minutes)
SNAPSHOT_MIN_GAP_MIN=5

# Spike thresholds (all optional; these are the defaults)
ALERT_Z=3                # robust z-score gate on mention velocity
ALERT_MIN_VEL=30         # minimum mentions/hour
ALERT_MIN_MENTIONS=50    # minimum absolute mentions
ALERT_MIN_PCT=20         # minimum percent jump
ALERT_LOOKBACK_MIN=60    # velocity window, minutes
ALERT_BASELINE_HOURS=12  # baseline window for the z-score
ALERT_COOLDOWN_MIN=90    # per-ticker quiet period after an alert
```

The systemd service loads this file via `EnvironmentFile`, so once it exists the
installed timer picks it up. To get a bot token, message `@BotFather`; to find a
chat id, add the bot to the group and read `getUpdates`. With no `alert.env`
present the watcher still collects data, it just skips alerting.

## Notes

- **Data lives in `data/trends.db`** (gitignored). Back it up if it matters.
- **Reddit OAuth** is optional; without `credentials.json` it uses the ApeWisdom
  API. See the main README.
- **Timezone**: cron uses the Pi's local time. Set it with `sudo raspi-config`
  or `timedatectl set-timezone <Area/City>`.
