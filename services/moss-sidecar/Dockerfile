FROM node:22-trixie-slim AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

FROM cgr.dev/chainguard/node:latest

ENV NODE_ENV=production \
    MOSS_DISABLE_TELEMETRY=1 \
    HOME=/tmp \
    MOSS_CACHE_PATH=/moss-cache \
    MOSS_MODEL_CACHE_DIR=/moss-cache/models \
    PORT=8080

WORKDIR /app

COPY --from=dependencies --chown=1000:1000 /app/node_modules ./node_modules
COPY --chown=1000:1000 server.mjs ./server.mjs
COPY deploy/Caddyfile /opt/moss/deploy/Caddyfile
COPY deploy/deploy-host.sh /opt/moss/deploy/deploy-host.sh

USER 1000:1000
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=4s --start-period=30s --retries=18 \
  CMD ["/usr/bin/node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["server.mjs"]
