# Deployment and runbook

## Local development (default verify path)

```bash
npm install
npx playwright install chromium
npm run dev
```

Default modes: healthcare `local`, agent `synthetic`. Session state is cookie-scoped
(`hv_demo_session`, HttpOnly, SameSite=Lax). Local development omits the Secure
cookie flag. Optional `DEMO_DATA_DIR` mirrors each session under
`sessions/{sessionId}/`.

Local Playwright uses `npm run build:next` then `next start`.

## Sites / Cloudflare durable path

Deployable Worker build (vinext + Cloudflare Vite plugin):

```bash
npm run build:sites
```

Required artifacts:

- `dist/server/index.js` (Worker entry from vinext)
- `dist/.openai/hosting.json` (copied from `.openai/hosting.json`, `d1: "DB"`)
- `drizzle/` SQL migrations packaged under `dist/.openai/drizzle`

Runtime repository selection:

- Worker injects `env.DB` onto `globalThis.__HARBORVIEW_ENV__` in `worker/index.ts`
  before the App Router handler runs
- `createSessionRepository` / `request-store` select `D1SessionRepository` whenever
  that binding exists
- Local Next / Playwright use `MemorySessionRepository` (optional `DEMO_DATA_DIR` mirror)
- `SqliteSessionRepository` (`src/server/sqlite-session-repository.ts`) is Node-test only
  and is never the public Worker authority

Public Sites may run healthcare `local` with agent `bff`: BFF classifies chat
turns, while server-owned grounded answers/proposals and synthetic local domain
connectors still produce demo mutation receipts. There are no live Medplum,
payer, or Stedi writes on the public path.

Current public release: https://overturn-agentic-claims.argentum1450.chatgpt.site

Moss integration first shipped in Sites version 21. The current release uses
`MOSS_EXECUTION=sidecar`: the Worker calls an authenticated route on the BFF AWS
acceptance host, where the official Node SDK loads and searches the Moss index
locally. The Worker stores only the dedicated sidecar credential; Moss project
credentials remain in AWS Secrets Manager. The sidecar has no host port,
contains only synthetic evidence, and is reachable externally only through the
TLS Caddy route.

## Connected adapters (optional)

Set server-only env from `.env.example`:

- `HEALTHCARE_MODE=medplum` + `MEDPLUM_*`
- `AGENT_MODE=bff` + `BFF_*`
- Local or direct cloud execution: `MOSS_MODE=live` + `MOSS_PROJECT_ID`,
  `MOSS_PROJECT_KEY`, and `MOSS_INDEX_NAME`
- Hosted sidecar execution: `MOSS_MODE=live`, `MOSS_EXECUTION=sidecar`,
  `MOSS_INDEX_NAME`, `MOSS_SIDECAR_URL`, and `MOSS_SIDECAR_API_KEY`

For Node development, `MOSS_EXECUTION=local` downloads the real Moss index once
and performs in-memory semantic search. Sites Workers use
`MOSS_EXECUTION=sidecar` because the current Moss SDK package includes native
Node binaries. The sidecar performs that same local search on AWS and returns a
small, episode-filtered result. No non-Moss retrieval fallback is enabled.

The AWS sidecar image and host deployment assets live under
`services/moss-sidecar`. The host keeps project credentials in a root-managed
Secrets Manager file mount, model/index cache in a dedicated Docker volume, and
the container on the existing private Compose network. A BFF host redeploy that
replaces `/opt/bff/Caddyfile` must re-run the sidecar deploy script to restore the
route.

Missing or failing connected config shows an explicit degraded / chat error state.
There is no silent fallback to synthetic chat classification. When healthcare
remains `local`, approved demo mutations still use the independent synthetic
domain executor; BFF `run_completed` alone is never a domain success receipt.

## Post-deploy live smoke

```bash
LIVE_BASE_URL=https://your-hosted-site.example npm run test:e2e:live
# Optional agent-mode badge assertion:
LIVE_BASE_URL=https://your-hosted-site.example LIVE_EXPECT_AGENT_MODE=bff npm run test:e2e:live
```

This mutates only anonymous synthetic sessions (submit, Claim B refresh, Claim C
deny/re-propose/allow, Claim D correction, Claim E docs, Claim F chat, isolation,
reset). It refuses connected healthcare mode, never writes to a real payer, and
never uses PHI.

## Reset and quarantine

`Reset demo` appends a session reset boundary for the current anonymous session
only. Corrupt event ledgers and mirrors fail closed and are quarantined on reset.
