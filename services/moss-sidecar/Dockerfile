FROM node:22-trixie-slim

ENV NODE_ENV=production \
    MOSS_DISABLE_TELEMETRY=1 \
    MOSS_CACHE_PATH=/home/node/.moss \
    MOSS_MODEL_CACHE_DIR=/home/node/.moss/models \
    PORT=8080

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force && \
    mkdir -p /home/node/.moss && \
    chown -R node:node /home/node/.moss /app

COPY --chown=node:node server.mjs ./server.mjs
COPY deploy/Caddyfile /opt/moss/deploy/Caddyfile
COPY deploy/deploy-host.sh /opt/moss/deploy/deploy-host.sh

USER node
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=4s --start-period=30s --retries=18 \
  CMD node -e "fetch('http://127.0.0.1:8080/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
