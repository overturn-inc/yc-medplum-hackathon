#!/usr/bin/env bash
# Polls the automation sidecar's liveness and readiness endpoints.
# Usage: scripts/health.sh [base_url]
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:${PORT:-8090}}"
DEADLINE=$((SECONDS + ${AUTOMATION_HEALTH_TIMEOUT_S:-60}))

echo "Waiting for ${BASE_URL}/health/ready ..."
until curl --fail --silent --show-error "${BASE_URL}/health/ready" >/dev/null; do
  if (( SECONDS >= DEADLINE )); then
    echo "Automation sidecar did not become ready in time." >&2
    exit 1
  fi
  sleep 2
done

echo "Live check:"
curl --fail --silent --show-error "${BASE_URL}/health" && echo
echo "Ready check:"
curl --fail --silent --show-error "${BASE_URL}/health/ready" && echo
echo "Automation sidecar is healthy."
