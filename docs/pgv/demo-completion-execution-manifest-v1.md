# Demo completion execution manifest v1

State: PLANNING

Date: 2026-08-01

## Desired outcome

Complete and publicly deploy the Overturn hackathon demo so one synthetic claim
can be shown from completed visit through claim creation, follow-through, payer
portal investigation, voice follow-up, denial resolution, formal appeal, and
audited next follow-up. The demo must use Medplum, Stedi, Moss, Deepgram, and
Breakfast Factory for visible, necessary work rather than logo-only claims.

## Routing manifest

```text
main: Codex, gpt-5.6-sol, xhigh, integration owner
planner: delegated fresh agent, gpt-5.6-sol, xhigh, read-only
generator: Cursor Generator MCP, cursor-grok-4.5-high, high, writable only within this repository
validator: delegated fresh agent, gpt-5.6-sol, xhigh, read-only
fallbacks: none without user approval
```

Cursor CLI preflight passed on 2026-08-01 and the exact account-visible generator
model is `cursor-grok-4.5-high`.

## End-to-end user scenarios

### S1 — Hero claim from visit to submitted

1. Reset the synthetic demo.
2. A completed encounter with a final note becomes visible.
3. The agent visibly checks coverage, coding, provider, diagnosis, service line,
   and charge.
4. A fixed approved synthetic Stedi 270/271 request returns active coverage.
5. A one-time approval creates and submits a synthetic claim through a clearly
   labeled simulated Stedi clearinghouse boundary.
6. Claim, receipt, lifecycle, dashboard, activity and audit views update.

### S2 — Follow-through with real browser work

1. The claim becomes accepted but overdue without remittance.
2. The agent starts a constrained browser job against a fictional public payer
   portal.
3. The UI immediately shows queued, navigating, typing, reading and completed
   progress plus screenshots or equivalent visual proof.
4. The portal returns a synthetic denial that conflicts with existing evidence.
5. The portal result is attached only to the active claim and updates its state.

### S3 — Voice last mile

1. When the portal result is insufficient, the agent starts a safe fixed-target
   synthetic payer call or an equivalently real Deepgram voice session.
2. Deepgram performs live speech recognition and voice output.
3. Call status, transcript, extracted facts, duration and provider receipt are
   visible and persisted on the same claim.
4. Failure, timeout, retry and duplicate-start behavior are explicit and safe.

### S4 — Evidence-grounded denial resolution and appeal

1. Moss retrieves only the active claim's portal, 277, authorization and call
   evidence.
2. The agent explains why correction or reprocessing precedes appeal.
3. After the synthetic denial is upheld, the agent prepares a formal appeal
   packet and exact portal submission preview.
4. Deny changes no external state.
5. Allow once drives the fictional payer portal, submits the appeal, captures a
   confirmation number, sets `appealed`, and schedules follow-up.
6. The claim receives artifact, execution receipt, Provenance and AuditEvent.
7. Duplicate approval or retry cannot submit a second appeal.

### S5 — Data and deployment proof

1. The connected Medplum synthetic project is the FHIR R4 data and audit plane
   for the hero claim, or the UI explicitly reports the connection as unavailable.
2. Public runtime secrets remain server-only.
3. The full public journey works from a new anonymous browser session and reset
   restores only that session.

## Acceptance matrix

| ID | Observable requirement | Verification method | Expected observation | Evidence needed |
|---|---|---|---|---|
| A01 | Guided hero flow covers visit, claim, follow-through, denial and appeal | Public browser E2E from reset | One synthetic claim advances through every stage without manual data repair | Playwright trace, final timeline and dashboard assertions |
| A02 | Public Stedi eligibility is real and synthetic-only | Invoke eligibility from hero preflight and inspect response/UI | Active test coverage returned for the fixed Jane Doe payload; no arbitrary patient input | Stedi API receipt, UI assertion, secret/client-bundle audit |
| A03 | Claim transport is honest | Inspect proposal, receipt and badges | Claim submission says simulated Stedi clearinghouse boundary and never implies live 837P or payment | UI assertions and documentation audit |
| A04 | Browser automation is real and constrained | Start portal investigation and inspect sidecar events | Allowlisted fictional portal is navigated, form fields are entered, denial is read, visual proof and receipt appear | Sidecar integration test, public E2E, target-allowlist and auth tests |
| A05 | Browser job failure paths are safe | Force bad target, timeout, duplicate and cancel paths | No arbitrary URL access, no false completion, resources close, retry is deterministic | Contract tests and sidecar logs without secrets |
| A06 | Deepgram is product-integrated | Start the voice path and inspect call/session output | Real Deepgram STT and TTS or Voice Agent use is visible with transcript, extracted facts and provider receipt | Live synthetic smoke, UI assertions, persisted evidence |
| A07 | Voice safety and failure paths hold | Test duplicate, timeout, provider error and public abuse controls | Fixed destination or safe mock only, rate limited, no arbitrary phone number, no false success | Contract tests and live failure smoke |
| A08 | Moss grounds the decision with claim isolation | Ask for appeal evidence after portal and voice events | Only active-claim documents return; new portal and call evidence are cited | Public Moss result, scope-guard tests |
| A09 | Formal appeal is complete and approval-gated | Deny once, re-propose, allow once, retry | Deny causes no write; approval submits once; confirmation, appealed state and follow-up appear | Unit, contract, replay and browser E2E |
| A10 | FHIR audit correspondence is exact | Inspect resources created for the hero claim | Claim, Task, DocumentReference, Provenance and AuditEvent references agree with receipts and timestamps | FHIR validation and Medplum adapter tests |
| A11 | Live Medplum use is truthful | Run connected synthetic-project smoke and inspect public badge | Connected read/write proof succeeds and public UI reports medplum; otherwise criterion remains unverified | Server validation output and public browser evidence |
| A12 | Async UX never appears frozen | Observe BFF, browser, voice and appeal actions | Progress appears within one second; completion or explicit error follows; buttons cannot double-submit | Timed browser assertions |
| A13 | Existing billing cases do not regress | Run current Encounter A and Claims B-F E2E | Submission, refresh, reprocessing, correction, documentation and verified-paid paths still pass | Existing local and public E2E output |
| A14 | Persistence, reset and isolation remain correct | Refresh, two sessions, one-session reset | Mutations persist per session; other session is unchanged; reset is scoped | Browser E2E |
| A15 | No PHI, secrets or unsafe external writes ship | Secret scan, public repo audit, client response inspection | Synthetic-only data, no credentials in repo/browser, no real payer write | Audit command output and deployment env-key inspection |
| A16 | Production deployment matches validated source | Build, commit, push, package, save, deploy and smoke exact SHA | Public URL serves the committed version and full hero smoke passes | Commit SHA, Sites version/deployment, public smoke output |

## Scope and architectural invariants

- Extend the existing Next/vinext/Sites application, D1 session ledger, BFF adapter,
  Moss sidecar and approval model. Preserve all existing routes and fixtures.
- Use synthetic patients, payer data, calls, documents and portal credentials only.
- Do not copy a real payer's trademarked identity or credential flow. Build a
  fictional payer portal that captures the workflow structure.
- Medplum remains the healthcare/FHIR data plane. Breakfast Factory remains the
  agent execution plane. Moss is retrieval only. Stedi eligibility is read-only.
- The current Stedi account does not permit live 837P claim submission. Do not
  attempt to bypass the 403 entitlement or describe synthetic transport as live.
- Read, compare, explain and draft may run automatically. Claim, payer message,
  documentation and appeal submissions require exact one-time approval.
- A model completion, browser event or phone transcript never proves an external
  mutation. Only the relevant connector receipt may advance the state.
- Browser automation must use a strict target/action allowlist, server-only
  authentication, bounded timeouts and cleanup. It must not accept arbitrary URLs,
  selectors, scripts, patient data or phone numbers from public clients.
- Existing secret scanning, public repository audit, D1 isolation and fail-closed
  behavior remain mandatory.

## Non-scope

- Real payer credentials or production payer portal automation.
- Live Stedi 837P, 277CA or 835 transactions without an upgraded account.
- Real patient data, production practice onboarding, HIPAA or BAA claims.
- General-purpose browser agent, dialer, appeal engine or multi-tenant admin.
- Rebuilding the established UI shell or unrelated product workspace code.

## Relevant failure paths

- BFF, Moss, browser sidecar, Deepgram, Twilio, Stedi or Medplum unavailable.
- Long model response, browser job timeout, call timeout and interrupted client.
- Stale revision, duplicate approval, duplicate webhook or duplicate job start.
- Invalid portal target, cross-claim evidence, malformed transcript or partial form.
- Deployment succeeds but environment variables, D1 migration or sidecar route are
  missing.
- Reset races with a running tool job.

## Preserved changes

- Branch `feat/hackathon-demo-completion` at `013ac57` was clean at manifest start.
- Preserve the existing public BFF and Moss integration, all synthetic fixtures,
  tests, design shell, D1 schema semantics and deployment metadata.
- Do not edit any file outside `dev/yc-medplum-hackathon`.

## Stop conditions

- Live Medplum cannot be claimed without a synthetic project and valid server-side
  credentials. Missing credentials require user action or an explicitly accepted
  reduced scope.
- A public phone action cannot ship until its destination, abuse control and consent
  model are safe and testable.
- A destructive database migration, real payer write, real PHI use, new paid service,
  or broad AWS permission change requires Main-agent adjudication and user authority.
- If Cursor Generator, AWS, Sites or a required sponsor API is unavailable, return
  the raw blocker and do not silently substitute a different backend or fake result.

## Required verification baseline

```text
npm run typecheck
npm run lint
npm run validate:fhir
npm run test:unit
npm run test:contract
npm run test:replay
npm run test:db
npm run test:public
npm run build:next
npm run test:e2e
npm run build:sites
npm run test:secrets
npm run verify
public hero E2E against the deployed URL
live Stedi synthetic eligibility smoke
live Deepgram synthetic voice smoke
live Medplum synthetic-project validation
browser sidecar authenticated and unauthenticated smoke
```
