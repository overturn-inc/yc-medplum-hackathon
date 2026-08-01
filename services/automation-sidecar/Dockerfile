FROM node:22-trixie-slim AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# Playwright's own image ships the exact Chromium build (and its Debian
# shared-library dependencies) matching the pinned "playwright" npm version,
# plus a pre-created non-root "pwuser" account intended for exactly this use
# case. Chainguard's node image cannot install Chromium's native deps (no
# apt), so it is not usable as the final runtime stage here.
FROM mcr.microsoft.com/playwright:v1.61.0-noble

ENV NODE_ENV=production \
    HOME=/tmp \
    PORT=8090 \
    PROOF_DIR=/tmp/automation-proof \
    AUTOMATION_BROWSER_HEADLESS=true

WORKDIR /app

COPY --from=dependencies --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --chown=pwuser:pwuser package.json ./package.json
COPY --chown=pwuser:pwuser server.mjs ./server.mjs
COPY --chown=pwuser:pwuser src ./src
COPY --chown=pwuser:pwuser assets ./assets
COPY deploy/Caddyfile /opt/automation/deploy/Caddyfile
COPY deploy/deploy-host.sh /opt/automation/deploy/deploy-host.sh

RUN mkdir -p /tmp/automation-proof && chown -R pwuser:pwuser /tmp/automation-proof

USER pwuser

EXPOSE 8090

HEALTHCHECK --interval=10s --timeout=4s --start-period=30s --retries=18 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8090/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.mjs"]
