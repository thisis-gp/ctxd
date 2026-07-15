#!/usr/bin/env bash
# Nightly Metabase ingest for hosted ctxd.
# Cron example (02:15 UTC):
#   15 2 * * * cd /opt/ctxd && ./scripts/nightly-refresh.sh >> /var/log/ctxd-refresh.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_ENV="${NODE_ENV:-production}"
node dist/cli.js refresh --prune-keep "${PRUNE_KEEP:-14}"
node dist/cli.js freshness
