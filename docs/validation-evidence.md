# Validation evidence

Validated: 2026-08-01 12:03 PDT (public release)

Final verdict: **PASS** after the final Claude Design implementation, local aggregate
gate, successful Sites deployment, public visual inspection, three earlier public
mutation E2E runs, and a final full live run against release 20.

Public release: https://overturn-agentic-claims.argentum1450.chatgpt.site

Public Sites release: version 20 from runtime commit
`21a949acd983084b107fe29a2e373ac6de3e3215`.

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
| Contract tests | Passed (38) |
| Replay tests | Passed (3) |
| Database / session / D1 tests | Passed (19) |
| Next.js production build (`build:next`) | Passed |
| Chromium E2E | Passed (17; includes BFF project) |
| vinext Sites build (`build:sites`) | Passed (`dist/server/index.js`) |
| package-site.sh archive | Passed |
| Secret canary | Passed |
| Public anonymous HTTP | Passed (200) |
| Public mutation E2E | Passed a final full run with required `Agent: bff` on version 20; three earlier full runs also passed |
| Public browser inspection | Passed: final dashboard rendered with all mode badges, KPI, queues, funnel, flags, and safety boundary |
| Pre-hydration interaction safety | Passed: controls remain non-interactive until React handlers are attached |
| Short viewport sidebar | Passed at 1280x500: session footer remained at y=455 before and after page scroll |
| Public navigation performance | Overview → Claims 821ms; Claims → detail 844ms; idle RSC prefetch requests 0 |

## G01-G21 acceptance matrix

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

- Public Sites can run local healthcare + BFF conversational agent: BFF classifies
  chat; grounded answers/proposals remain server-owned; synthetic local connectors
  still produce demo mutation receipts.
- Sites deployability is evidenced by `build:sites` + `package-site.sh`, not by schema files alone.
- Public BFF is live through the AWS acceptance environment and Bedrock Sonnet;
  failures remain visible and there is no silent conversational fallback.
- No claim of live Stedi, live Medplum credentials, or live payer writes.
- `LIVE_BASE_URL=https://overturn-agentic-claims.argentum1450.chatgpt.site
  LIVE_EXPECT_AGENT_MODE=bff npm run test:e2e:live` passed the final release-20
  run after three earlier full runs. The runs covered Encounter A submission, Claim B refresh, Claim C deny,
  re-propose and allow, Claim D correction, Claim E documentation, Claim F's
  unsafe-action refusal and absence of a proposal, dashboard persistence, two
  browser sessions, reset, and current-state answers after actions.
- A separate manual browser journey confirmed that Claim C's live BFF answer cited
  the PMS, payer, and authorization evidence; Deny created no write; re-proposal
  restored Allow once; approval produced a receipt; and the dashboard approval
  count changed from 4 to 3.
- The final public dashboard was opened again after version 20 deployment and
  visually inspected at the production URL; the mode badges reported synthetic
  healthcare data, local healthcare, BFF mode, and no live payer writes.
- Public page rendering no longer synchronously probes BFF readiness. The remote
  boundary is checked by chat and approval requests, where failures remain visible
  and approved actions fail closed without synthetic fallback.

## Residual non-blocking risks

- Reset clears auxiliary D1 tables separately from appending the reset boundary;
  a contrived simultaneous reset/action race is not fully transactional.
- Claim B uses a frozen demo clock, so repeated refreshes can reuse logical labels.
- Public sessions and chat history are intentionally unbounded for this short-lived
  synthetic hackathon demo.
