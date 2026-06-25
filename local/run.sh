#!/usr/bin/env bash
# Convenience wrapper for local runs. Loads .env (if present) then runs the watcher.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
exec node monitor.js
