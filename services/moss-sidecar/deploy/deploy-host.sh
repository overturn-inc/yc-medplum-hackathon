#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="${MOSS_DEPLOY_CONFIG_FILE:-/etc/moss-sidecar/deploy.env}"
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

required=(AWS_REGION MOSS_IMAGE_URI MOSS_SECRET_ARN BFF_PUBLIC_HOST BFF_LOG_GROUP)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "${name} is required." >&2
    exit 1
  fi
done

umask 077
install -d -m 0700 /run/moss-sidecar /opt/moss-sidecar
aws secretsmanager get-secret-value \
  --region "${AWS_REGION}" \
  --secret-id "${MOSS_SECRET_ARN}" \
  --query SecretString \
  --output text > /run/moss-sidecar/secret.json
python3 -c 'import json; d=json.load(open("/run/moss-sidecar/secret.json")); assert all(isinstance(d.get(k), str) and d[k] for k in ("projectId", "projectKey", "indexName", "apiKey"))'
chown 1000:1000 /run/moss-sidecar/secret.json
chmod 0400 /run/moss-sidecar/secret.json

registry="${MOSS_IMAGE_URI%%/*}"
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${registry}" >/dev/null
docker pull "${MOSS_IMAGE_URI}" >/dev/null

asset_container="moss-sidecar-deploy-assets"
docker rm -f "${asset_container}" >/dev/null 2>&1 || true
docker create --name "${asset_container}" "${MOSS_IMAGE_URI}" true >/dev/null
docker cp "${asset_container}:/opt/moss/deploy/Caddyfile" /opt/moss-sidecar/Caddyfile
docker rm -f "${asset_container}" >/dev/null
chmod 0644 /opt/moss-sidecar/Caddyfile

docker rm -f moss-sidecar >/dev/null 2>&1 || true
docker volume create moss-sidecar-data >/dev/null
docker run -d \
  --name moss-sidecar \
  --restart unless-stopped \
  --network bff-acceptance_default \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --memory 768m \
  --cpus 1.0 \
  --env MOSS_SECRET_FILE=/run/secrets/moss.json \
  --mount type=bind,src=/run/moss-sidecar/secret.json,dst=/run/secrets/moss.json,readonly \
  --mount type=volume,src=moss-sidecar-data,dst=/home/node/.moss \
  --log-driver awslogs \
  --log-opt "awslogs-region=${AWS_REGION}" \
  --log-opt "awslogs-group=${BFF_LOG_GROUP}" \
  --log-opt awslogs-stream=moss-sidecar \
  "${MOSS_IMAGE_URI}" >/dev/null

deadline=$((SECONDS + 240))
until [[ "$(docker inspect --format '{{.State.Health.Status}}' moss-sidecar 2>/dev/null || true)" == "healthy" ]]; do
  if (( SECONDS >= deadline )); then
    docker logs --tail 30 moss-sidecar >&2 || true
    echo "Moss sidecar did not become healthy." >&2
    exit 1
  fi
  sleep 4
done

if [[ ! -e /opt/bff/Caddyfile.pre-moss ]]; then
  cp /opt/bff/Caddyfile /opt/bff/Caddyfile.pre-moss
fi
cp /opt/moss-sidecar/Caddyfile /opt/bff/Caddyfile
chmod 0644 /opt/bff/Caddyfile

cd /opt/bff
docker compose --env-file /etc/bff/deploy.env up -d --force-recreate caddy >/dev/null
deadline=$((SECONDS + 90))
until curl --fail --silent --show-error "https://${BFF_PUBLIC_HOST}/health/ready" >/dev/null; do
  if (( SECONDS >= deadline )); then
    cp /opt/bff/Caddyfile.pre-moss /opt/bff/Caddyfile
    docker compose --env-file /etc/bff/deploy.env up -d --force-recreate caddy >/dev/null
    echo "Caddy did not become ready; restored the previous route." >&2
    exit 1
  fi
  sleep 3
done

status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST "https://${BFF_PUBLIC_HOST}/v1/moss/query" \
  --header 'Content-Type: application/json' \
  --data '{"episodeId":"episode-claim-c","query":"status"}')"
if [[ "${status}" != "401" ]]; then
  echo "Moss public route did not enforce authentication." >&2
  exit 1
fi

echo "Moss sidecar and authenticated route are healthy."
