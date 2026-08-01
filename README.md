# Overturn for YC Medplum Hackathon 2026

Agent-native PMS demo: conversational claim workbench with approval-gated
synthetic actions across seven encounter/claim episodes.

**Public demo:** https://overturn-agentic-claims.argentum1450.chatgpt.site

## Requirements

- Node.js **20.19+**
- npm

## Quick start

```bash
npm install
npx playwright install chromium
npm run dev
```

Open [http://localhost:3000/dashboard](http://localhost:3000/dashboard). No login.
Data is synthetic. Anonymous sessions are isolated by an HttpOnly cookie.

## Adapter modes

| Mode | Env | Behavior |
|---|---|---|
| Healthcare `local` (default) | `HEALTHCARE_MODE=local` | Typed FHIR fixtures + session-scoped event store |
| Healthcare `medplum` | `HEALTHCARE_MODE=medplum` + `MEDPLUM_*` | Connected read path; **no silent fallback** to local |
| Agent `synthetic` (default) | `AGENT_MODE=synthetic` | Deterministic chat, proposals, and execution |
| Agent `bff` | `AGENT_MODE=bff` + `BFF_*` | Live BFF conversational classification; grounded answers and proposals stay server-owned; local synthetic domain connectors still produce mutation receipts |
| Retrieval `off` (default) | `MOSS_MODE=off` | Domain-grounded chat without external semantic retrieval |
| Retrieval `live` | `MOSS_MODE=live` + `MOSS_*` | Moss claim-scoped semantic retrieval; Node demos use local in-memory execution and hosted Workers call the authenticated AWS local-search sidecar |

In public Sites `AGENT_MODE=bff` with healthcare `local`, Breakfast Factory handles
readiness and chat intent only. It never becomes the proof of a healthcare write.
Copy `.env.example` to `.env` for local overrides. Credentials are **server-only**.
Never use `NEXT_PUBLIC_` for secrets.

## Public repository safety

- `.env*`, `.dev.vars*`, private keys, certificates, and common credential files
  are ignored. Only the empty-value `.env.example` template is committed.
- Configure Medplum, BFF, Moss, and hosting credentials in the deployment platform's
  encrypted environment or secret store. Do not add them to `wrangler.jsonc`.
- `npm run test:public` audits tracked files for credential-shaped values,
  private keys, absolute workstation paths, and unsafe symlinks.
- All included patient, payer, claim, remittance, and posting data is synthetic.

The application does not need a Medplum source checkout. Contributors who want
to inspect Medplum internals may create an ignored local link:

```bash
git clone https://github.com/medplum/medplum.git ../medplum
ln -s ../medplum medplum-link
```

## 5-minute demo

1. **Dashboard** — seven synthetic cases, synthetic/no-live-write badges, KPI and queues.
2. **Encounter A / Claim A** — chat or approve submission; receipt appears; adjudication stays not found.
3. **Claim B** — overdue status; refresh adds payer observation and follow-up; never paid.
4. **Claim C** — PMS processing vs payer authorization denial; ask for evidence and show the live Moss matches, scores, latency, and ranked citations; Deny / Re-propose / Allow once.
5. **Claim D** — clearinghouse rejection (not payer denial); correct and resubmit preserves original.
6. **Claim E** — send existing signed supporting note after approval.
7. **Claim F** — verified paid only with independent remittance + PMS posting.
8. **Refresh** persists session state; **Reset demo** restores only the current session.
9. Ask for status again after each action; the agent cites the current receipt,
   resolution, and next follow-up instead of repeating the pre-action state.

## Verification

```bash
npm run typecheck
npm run lint
npm run validate:fhir
npm run test:unit
npm run test:contract
npm run test:replay
npm run test:db
npm run build:next
npm run test:e2e
npm run build:sites
npm run test:secrets
npm run test:public
npm run verify
```

Post-deploy live smoke (no payer writes, no PHI):

```bash
LIVE_BASE_URL=https://your-site.example npm run test:e2e:live
# Optional: assert the live dashboard Agent badge before mutations
LIVE_BASE_URL=https://your-site.example LIVE_EXPECT_AGENT_MODE=bff npm run test:e2e:live
```

Optional connected adapters (credentials required, not part of default verify):

```bash
npm run seed:medplum
npm run test:medplum
npm run seed:moss
npm run test:moss:live
```

## Synthetic limitations

- All patients, payers, authorizations, portal snapshots, 277/835, and messages are **synthetic** in default local mode.
- Realistic denial, portal follow-up, and reprocessing are demo connectors — not live payer writes.
- `Verified paid` means matching remittance **and** independent reconciled PMS posting DocumentReference. It is **not** bank settlement.
- Chat never performs healthcare writes. Action requests create server-built proposals,
  except Claim B's explicit read-only payer status refresh, which appends an observation
  without Allow once and never marks the claim paid.
- Approval is bound to `proposalId`, `payloadDigest`, `episodeRevision`, and fingerprint.
- BFF `run_completed` proves model completion only; domain connector receipts prove mutation success.
- Connected BFF/Medplum adapters are mock-testable HTTP clients. Default verify never requires live credentials.
- Moss indexes only the synthetic operational evidence corpus. Names and member IDs are omitted, results are filtered again by episode on the server, and retrieval never authorizes a write.
- The public Worker never receives the Moss project key. It holds a separate
  server-only sidecar credential and calls a read-only Node service on the BFF
  AWS acceptance host; that service loads the official Moss SDK and index locally.
- Durable Sites path: `npm run build:sites` produces `dist/server/index.js` plus
  hosting metadata and drizzle migrations. The Worker injects `env.DB` and selects
  `D1SessionRepository` at runtime. Local verify still uses Next.js plus memory/SQLite
  test adapters — schema alone is not a substitute for the Worker build.

## Product docs

- [Product spec](docs/product-spec.md)
- [Demo scenario v2 and readiness audit](docs/demo-scenario-v2-readiness.md)
- [Data and agent architecture](docs/data-agent-architecture.md)
- [Deployment runbook](docs/deployment-runbook.md)
- [Hackathon submission draft](docs/hackathon-submission-draft.md)
- [Implementation plan](docs/implementation-plan.md)
- [Validation evidence](docs/validation-evidence.md)
