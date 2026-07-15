#!/usr/bin/env bash
#
# Release automation (§8): build -> validate -> publish -> (deploy + health) -> promote.
#
# Runs inside a release pipeline against an exact checked-out tag. The current
# pointer advances ONLY after deploy + health checks pass; any failure leaves the
# previous `current` untouched so rollback is a no-op.
#
# Usage:
#   scripts/release.sh <release-tag> [previous-release-tag]
#
# Env:
#   METABASE_URL, METABASE_API_KEY   required (snapshot build)
#   DEPLOY_SCRIPT                     optional path to an executable deploy script
#   HEALTHCHECK_SCRIPT               optional path to an executable health-check script
#
# DEPLOY_SCRIPT / HEALTHCHECK_SCRIPT are executed directly (never via `eval`) and
# must be executable files, so a malformed env value cannot inject shell commands.
set -euo pipefail

RELEASE="${1:?usage: release.sh <release-tag> [previous-release-tag]}"
PREVIOUS="${2:-}"
GIT_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo '')"

CLI="node dist/cli.js"

run_hook() {
  local label="$1" script="$2"
  [ -z "${script}" ] && return 0
  if [ ! -x "${script}" ]; then
    echo "!! ${label} script '${script}' is not an executable file" >&2
    exit 1
  fi
  echo ">> ${label}: ${script}"
  "${script}"
}

echo ">> Building snapshot for ${RELEASE} (commit ${GIT_COMMIT:-unknown})"
BUILD_ARGS=(--release "${RELEASE}" --force)
[ -n "${GIT_COMMIT}" ] && BUILD_ARGS+=(--git-commit "${GIT_COMMIT}")
[ -n "${PREVIOUS}" ] && BUILD_ARGS+=(--previous "${PREVIOUS}")
$CLI snapshot build "${BUILD_ARGS[@]}"

echo ">> Validating snapshot"
VALIDATE_ARGS=(--release "${RELEASE}")
[ -n "${PREVIOUS}" ] && VALIDATE_ARGS+=(--previous "${PREVIOUS}")
$CLI snapshot validate "${VALIDATE_ARGS[@]}"

echo ">> Publishing snapshot"
$CLI snapshot publish --release "${RELEASE}"

run_hook "Deploy" "${DEPLOY_SCRIPT:-}"
run_hook "Health check" "${HEALTHCHECK_SCRIPT:-}"

echo ">> Promoting ${RELEASE} to current"
$CLI snapshot promote --release "${RELEASE}"

echo ">> Release ${RELEASE} complete."
