#!/usr/bin/env bash
# Cron-friendly wrapper around collect.js. Handles the minimal environment cron
# provides: changes into the project dir, ensures node is on PATH (works whether
# node is system-installed or managed by nvm), then runs one collection.
#
# Example crontab entry (every 30 min), logging to data/collect.log:
#   */30 * * * * /home/pi/reddit-trends/scripts/collect.sh >> /home/pi/reddit-trends/data/collect.log 2>&1
set -euo pipefail

# Resolve the project root from this script's location (scripts/ -> ..).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Make common node locations reachable under cron's stripped-down PATH.
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

# If node is managed by nvm, load it and use the version pinned in .nvmrc.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm use --silent >/dev/null 2>&1 || true
fi

exec node collect.js
