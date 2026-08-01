# Validation evidence

Validated: 2026-08-01 (public release)

Final verdict: **PASS** from a fresh independent Validator after two repair cycles.

Public release: https://overturn-agentic-claims.argentum1450.chatgpt.site

## Aggregate gate

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
bash /Users/jeonhwichan/.codex/plugins/cache/openai-bundled/sites/0.1.33/skills/sites-hosting/scripts/package-site.sh . /private/tmp/overturn-sites-repair.tar.gz
npm run test:secrets
npm run verify
```

| Gate | Result |
|---|---|
| TypeScript | Passed |
| ESLint | Passed |
| FHIR validation | Passed (3) |
| Unit tests | Passed (36) |
| Contract tests | Passed (27) |
| Replay tests | Passed (3) |
| Database / session / D1 tests | Passed (7) |
| Next.js production build (`build:next`) | Passed |
| Chromium E2E | Passed (15; includes BFF project) |
| vinext Sites build (`build:sites`) | Passed (`dist/server/index.js`) |
| package-site.sh archive | Passed |
| Secret canary | Passed |
| Public anonymous HTTP | Passed (200) |
| Public mutation E2E | Passed |
| Independent final Validator | Passed at `5b0c58f` |

## G01-G20 acceptance matrix

| ID | Criterion | Status |
|---|---|---|
| G01 | `build:sites` exits 0 with `dist/server/index.js` + hosting + migrations | Pass |
| G02 | Worker selects real D1 repository via `env.DB` | Pass |
| G03 | Two ActionService instances share one repo → one Allow once effect | Pass |
| G04 | Arbitrary action injection rejected; Claim F submit rejected | Pass |
| G05 | Claim D old→new member ID + original/corrected Claim.related | Pass |
| G06 | Claim B refresh needs no Allow once / no approval.consumed | Pass |
| G07 | Free-text intents classify correctly; proposal-only (except B refresh) | Pass |
| G08 | BFF chat uses strict classifier; visible failure; no synthetic fallback | Pass |
| G09 | Connected verified-paid fails closed on posting mismatches | Pass |
| G10 | Missing reset / corrupt mirror fail closed | Pass |
| G11 | Same-encounter multi-claim does not cross-link evidence | Pass |
| G12 | Chat input labeled; 390px no horizontal overflow; keyboard works | Pass |
| G13 | Live E2E mutates synthetic sessions only; refuses connected healthcare | Pass on public release |
| G14 | Docs honest about Sites readiness | Pass |
| G15 | No secrets/PHI/live payer writes introduced | Pass |
| G16 | Session cookie isolation + per-session reset | Pass |
| G17 | D1 unique reservation concurrency | Pass |
| G18 | Medplum posting amount/control/reference exact match | Pass |
| G19 | package-site.sh accepts archive | Pass |
| G20 | `npm run verify` includes Next + Sites builds | Pass |
| G21 | Post-action agent status uses current receipts/state/follow-up | Pass |

## Honest boundary

- Default public path is local healthcare + synthetic agent.
- Sites deployability is evidenced by `build:sites` + `package-site.sh`, not by schema files alone.
- Connected BFF/Medplum remain optional; failure is visible; no silent fallback.
- No claim of live Stedi, live Medplum credentials, or live payer writes.
- `LIVE_BASE_URL=https://overturn-agentic-claims.argentum1450.chatgpt.site npm run test:e2e:live`
  passed Encounter A submission, Claim B refresh, Claim C reprocessing, Claim D
  correction, Claim E documentation, Claim F safety, dashboard persistence, two
  browser sessions, and reset. It also asked the agent for current status after
  actions and rejected stale pre-action answers.

## Residual non-blocking risks

- Exact approval execution is durably reserved, but simultaneous unrelated writes
  in the same anonymous session do not use a database-level session CAS.
- Claim B uses a frozen demo clock, so repeated refreshes can reuse logical labels.
- Public sessions and chat history are intentionally unbounded for this short-lived
  synthetic hackathon demo.
