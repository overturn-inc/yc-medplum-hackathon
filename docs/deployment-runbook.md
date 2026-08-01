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

Moss integration first shipped in Sites version 21 from runtime commit
`556a7804b90b4db0a13b98062abe47b20f164279`. It contains the Moss retrieval
integration; public Moss mode is temporarily off because the hosted query
endpoint returned 503. The full live mutation E2E passed on release 20 with the
`Agent: bff` assertion on 2026-08-01, and release 21 passed public config smoke.

## Connected adapters (optional)

Set server-only env from `.env.example`:

- `HEALTHCARE_MODE=medplum` + `MEDPLUM_*`
- `AGENT_MODE=bff` + `BFF_*`
- `MOSS_MODE=live` + `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY`, and `MOSS_INDEX_NAME`

For Node development, `MOSS_EXECUTION=local` downloads the real Moss index once
and performs in-memory semantic search. Sites Workers use `MOSS_EXECUTION=cloud`
because the current Moss SDK package includes native Node binaries. Both paths
use Moss; no non-Moss retrieval fallback is enabled.

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
