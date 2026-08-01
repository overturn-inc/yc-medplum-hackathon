#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${AUTOMATION_DEPLOY_CONFIG_FILE:-/etc/automation-sidecar/deploy.env}"
if [[ "$(id -u)" -ne 0 ]]; then
  echo "deploy-host.sh must run as root." >&2
  exit 1
fi
if [[ ! -r "${CONFIG_FILE}" || ! -r /etc/bff/deploy.env ]]; then
  echo "Deployment configuration is unavailable." >&2
  exit 1
fi

set -a
# Resource identifiers only. Secrets remain in Secrets Manager.
# shellcheck disable=SC1090
. "${CONFIG_FILE}"
# shellcheck disable=SC1091
. /etc/bff/deploy.env
set +a

required=(AWS_REGION AUTOMATION_IMAGE_URI AUTOMATION_SECRET_ARN BFF_PUBLIC_HOST BFF_LOG_GROUP)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "${name} is required." >&2
    exit 1
  fi
done

umask 077
install -d -m 0700 /run/automation-sidecar /opt/automation-sidecar
aws secretsmanager get-secret-value \
  --region "${AWS_REGION}" \
  --secret-id "${AUTOMATION_SECRET_ARN}" \
  --query SecretString \
  --output text > /run/automation-sidecar/secret.json
python3 -c 'import json; d=json.load(open("/run/automation-sidecar/secret.json")); assert isinstance(d.get("apiKey"), str) and d["apiKey"]'
chown 1001:1001 /run/automation-sidecar/secret.json
chmod 0400 /run/automation-sidecar/secret.json

registry="${AUTOMATION_IMAGE_URI%%/*}"
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${registry}" >/dev/null
docker pull "${AUTOMATION_IMAGE_URI}" >/dev/null

asset_container="automation-sidecar-deploy-assets"
docker rm -f "${asset_container}" >/dev/null 2>&1 || true
docker create --name "${asset_container}" "${AUTOMATION_IMAGE_URI}" true >/dev/null
docker cp "${asset_container}:/opt/automation/deploy/Caddyfile" /opt/automation-sidecar/Caddyfile
docker rm -f "${asset_container}" >/dev/null
chmod 0644 /opt/automation-sidecar/Caddyfile

docker rm -f automation-sidecar >/dev/null 2>&1 || true
# Resource caps for the demo host: one headless Chromium instance plus a
# small concurrency limit needs modest but non-trivial memory. --read-only
# with a tmpfs /tmp holds Chromium's profile dir and the TTL-managed proof
# volume; nothing here needs to persist across a restart.
docker run -d \
  --name automation-sidecar \
  --restart unless-stopped \
  --network bff-acceptance_default \
  --read-only \
  --tmpfs /tmp:rw,exec,nosuid,size=512m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --memory 1536m \
  --cpus 1.5 \
  --env AUTOMATION_SECRET_FILE=/run/secrets/automation.json \
  --env AUTOMATION_JOB_CONCURRENCY=2 \
  --env AUTOMATION_JOB_TIMEOUT_MS=90000 \
  --mount type=bind,src=/run/automation-sidecar/secret.json,dst=/run/secrets/automation.json,readonly \
  --log-driver awslogs \
  --log-opt "awslogs-region=${AWS_REGION}" \
  --log-opt "awslogs-group=${BFF_LOG_GROUP}" \
  --log-opt awslogs-stream=automation-sidecar \
  "${AUTOMATION_IMAGE_URI}" >/dev/null

deadline=$((SECONDS + 240))
until [[ "$(docker inspect --format '{{.State.Health.Status}}' automation-sidecar 2>/dev/null || true)" == "healthy" ]]; do
  if (( SECONDS >= deadline )); then
    docker logs --tail 30 automation-sidecar >&2 || true
    echo "Automation sidecar did not become healthy." >&2
    exit 1
  fi
  sleep 4
done

if [[ ! -e /opt/bff/Caddyfile.pre-automation ]]; then
  cp /opt/bff/Caddyfile /opt/bff/Caddyfile.pre-automation
fi
cp /opt/automation-sidecar/Caddyfile /opt/bff/Caddyfile
chmod 0644 /opt/bff/Caddyfile

cd /opt/bff
docker compose --env-file /etc/bff/deploy.env up -d --force-recreate caddy >/dev/null
deadline=$((SECONDS + 90))
until curl --fail --silent --show-error "https://${BFF_PUBLIC_HOST}/health/ready" >/dev/null; do
  if (( SECONDS >= deadline )); then
    cp /opt/bff/Caddyfile.pre-automation /opt/bff/Caddyfile
    docker compose --env-file /etc/bff/deploy.env up -d --force-recreate caddy >/dev/null
    echo "Caddy did not become ready; restored the previous route." >&2
    exit 1
  fi
  sleep 3
done

job_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST "https://${BFF_PUBLIC_HOST}/v1/automation/jobs" \
  --header 'Content-Type: application/json' \
  --data '{"action":"investigate_claim","idempotencyKey":"deploy-smoke","episodeId":"episode-encounter-a","sessionRevision":1,"episodeRevision":1}')"
if [[ "${job_status}" != "401" ]]; then
  echo "Automation job route did not enforce authentication." >&2
  exit 1
fi

portal_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "https://${BFF_PUBLIC_HOST}/northstar-portal/login")"
if [[ "${portal_status}" != "200" ]]; then
  echo "Public Northstar portal route is not reachable." >&2
  exit 1
fi

echo "Automation sidecar, authenticated job route, and public portal are healthy."
