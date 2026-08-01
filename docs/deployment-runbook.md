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
bash /Users/jeonhwichan/.codex/plugins/cache/openai-bundled/sites/0.1.33/skills/sites-hosting/scripts/package-site.sh . /private/tmp/overturn-sites-release.tar.gz
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

Public default success path remains deterministic synthetic mode (no Medplum
credentials, no live payer writes).

Current public release: https://overturn-agentic-claims.argentum1450.chatgpt.site

Validated public release: Sites version 11 from commit `202d9d8`; the full live
mutation E2E passed three consecutive runs plus one enhanced safety-assertion run
on 2026-08-01.

## Connected adapters (optional)

Set server-only env from `.env.example`:

- `HEALTHCARE_MODE=medplum` + `MEDPLUM_*`
- `AGENT_MODE=bff` + `BFF_*`

Missing or failing connected config shows an explicit degraded / chat error state.
There is no silent fallback to synthetic fixtures or synthetic chat classification.

## Post-deploy live smoke

```bash
LIVE_BASE_URL=https://your-hosted-site.example npm run test:e2e:live
```

This mutates only anonymous synthetic sessions (submit, Claim B refresh, Claim C
deny/re-propose/allow, Claim D correction, Claim E docs, Claim F chat, isolation,
reset). It refuses connected healthcare mode, never writes to a real payer, and
never uses PHI.

## Reset and quarantine

`Reset demo` appends a session reset boundary for the current anonymous session
only. Corrupt event ledgers and mirrors fail closed and are quarantined on reset.
