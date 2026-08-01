# Validation evidence

Validated: 2026-08-01 13:52 PDT (Moss integration and public release)

Final verdict: **PASS** after the final Claude Design implementation, Moss live
SDK and browser validation, local aggregate gate, successful Sites deployment,
public inspection, three earlier public mutation E2E runs, and a final full live
run against release 20.

Public release: https://overturn-agentic-claims.argentum1450.chatgpt.site

Moss integration release: Sites version 21 from runtime commit
`556a7804b90b4db0a13b98062abe47b20f164279`. Moss code and encrypted credentials
were deployed, but public `MOSS_MODE` is intentionally off while the hosted query
endpoint returns 503. Release 20 remains the latest full public mutation E2E.

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
npm run test:secrets
npm run test:public
npm run verify
```

| Gate | Result |
|---|---|
| TypeScript | Passed |
| ESLint | Passed |
| FHIR validation | Passed (3) |
| Unit tests | Passed (36) |
| Contract tests | Passed (48) |
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
- A post-release local Stedi integration passed a real test-mode 270/271 API
  request and UI journey using Stedi's approved synthetic Jane Doe record. The
  Stedi portal recorded the check as Active, and the response contained five
  active benefits plus the raw 271 X12 payload.
- The current Stedi account is Sandbox. A direct test call to the professional
  claims endpoint returned HTTP 403 `access_denied`; the portal likewise says
  claims are unavailable until upgrade. No 837P, 277CA, 835, production payer,
  or real PHI claim is made.
- No claim of live Stedi claim submission, live Medplum credentials, or live payer writes.
- A dedicated Moss index named `overturn-claims-demo-v1` was created with 39
  synthetic-only documents. The official SDK loaded that live index and returned
  only Claim C documents through a metadata filter. Cold load was 1,484ms and
  warm local semantic search was 7.8ms in the standalone proof.
- A production Next server and manual browser journey then returned four Moss
  documents for “What evidence supports reprocessing?”, ranked the assistant's
  episode citations from those matches, and visibly rendered the sources,
  scores, and 13.9ms warm retrieval latency. No proposal or write was created.
- Moss credentials remain server-only in the ignored local environment. The
  indexed corpus omits patient names and member IDs, and contract tests reject
  cross-episode documents after retrieval.
- Moss's hosted cloud query endpoint returned HTTP 503 during final validation.
  The official SDK local in-memory path is working; public Worker activation
  remains contingent on the hosted query service recovering or a Node retrieval
  sidecar being deployed.
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
