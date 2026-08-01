# Implementation plan

Status: Repair generator complete for demo-completion-repair-1; awaiting Validator

Plan version: v3 (demo completion repair)

Turn state: GENERATED

## Routing manifest

```text
main: Codex, current root session, integration owner
planner: gpt-5.6-sol, xhigh, isolated read-only agent
generator: Cursor Generator, cursor-grok-4.5-high, demo-completion-repair-1
validator: gpt-5.6-sol, xhigh, fresh isolated read-only agent
fallbacks: no silent model or adapter substitution
```

## Objective

Repair Validator-confirmed defects and deliver a Sites-deployable, concurrency-safe,
claim-correct demo: real vinext/D1 Worker path, atomic Allow once, server-owned
action policy, Claim B/D/F semantics, BFF chat boundary, fail-closed ledgers, and
honest docs.

## Environment

- Node 20.19 or newer (Sites/wrangler build prefers Node 22+)
- npm with committed lockfile
- Next.js 16 App Router (local verify via `build:next`)
- vinext 0.0.50 + Vite 8 + Cloudflare Vite plugin (Sites via `build:sites`)
- React 19.2.6
- TypeScript 5.9
- `@medplum/fhirtypes` and `@medplum/core` 5.1.27
- Zod 4
- drizzle-orm 0.45.2; better-sqlite3 for Node SQLite tests only
- Vitest 4
- Playwright 1.61
- Sites hosting: `.openai/hosting.json` D1 binding `DB` (no invented project_id)

## Demo-completion slices (v2)

1. Session-scoped repository + cookie isolation + D1 schema/migration
2. Strict DomainEvent Zod schemas and fail-closed replay
3. Verified-paid independent remittance + PMS posting evidence
4. Medplum claim-scoped R4 mapping
5. Strict BFF RunEventV1 + SSE-only; run_completed is not a domain receipt
6. Conversational agent API/UI with proposal-only mutations
7. Claim B/D/E actions + Encounter A / Claim A / Claim C / Claim F journeys
8. Expanded unit/contract/replay/db/e2e coverage and `npm run verify`
9. Honest README, architecture, runbook, submission draft, validation evidence

## Architecture invariants

- A single product claim status is forbidden.
- Every external observation is immutable and carries source, raw value, normalized value, timestamp, and evidence reference.
- Submitted requires a transmission receipt; submission ends at clearinghouse_received with adjudication not_found.
- Reprocessed is not paid.
- Verified paid requires matching remittance and independent reconciled PMS posting DocumentReference.
- BFF output cannot mutate healthcare state directly.
- Approval is scoped to action, target, payload digest, and episode revision.
- Connected adapter failure never falls back silently.
- No real PHI, external payer write, or interview asset enters the project.
- Credentials stay server-side and never use `NEXT_PUBLIC_`.
- Session reset affects only the current anonymous session.

See also: docs/validation-evidence.md, docs/deployment-runbook.md, docs/hackathon-submission-draft.md.

## Ordered implementation slices

### Slice 0: runnable acceptance shell

Outcome:

- `/dashboard`, `/encounters`, `/claims`, `/claims/[id]` render inside one PMS shell.
- Synthetic data and adapter mode badges are visible.
- Typecheck, lint, test, build, and Playwright harnesses run.

Boundaries:

- Use deterministic demo clock.
- Use accessibility-first semantic HTML and keyboard-reachable controls.
- Do not copy logos, trade dress, or interview assets.

### Slice 1: multi-axis episode model and persistent synthetic source

Outcome:

- Seven typed fixture projections load through the application repository.
- Primary bucket total equals the episode count.
- Overlay flags do not change the primary total.
- Deterministic discrepancy, verified-paid, preflight, and replay functions pass table tests.
- Refresh and server restart replay the same state.
- Reset appends a demo-session boundary event and restores the initial projection without deleting connected resources.

Expected change points:

- Domain types and pure selectors
- Typed FHIR Bundle fixtures
- Append-only NDJSON local event repository under ignored `var/`
- Read, mutate, reset server routes

### Slice 2: PMS dashboard and read paths

Outcome:

- Dashboard KPI, agent approvals, exception queue render exact fixture-derived values.
- Encounter and claim tables expose the fields and filters in the product spec.
- Workbench renders source observations in the fixed lifecycle order with evidence drawer.

Expected change points:

- Dashboard selectors and cards
- Encounter and claim table components
- Claim workbench timeline, financial card, evidence drawer

### Slice 3: preflight and approval-gated submission

Outcome:

- Encounter A shows final-note, coverage, provider, diagnosis, service-line, charge checks.
- Proposal generation does not mutate transport state.
- Deny produces only a decision event.
- Allow once creates a Claim, submission receipt, submitted observation, and audit event.
- Ready decreases by one and submitted increases by one.
- Duplicate requests are idempotent.

Expected change points:

- Preflight service
- Proposal, approval, fingerprint, and idempotency domain
- Synthetic submission executor
- Mutation routes and client revalidation

### Slice 4: agent-native discrepancy resolution

Outcome:

- Claim C shows PMS processing and payer authorization denial with source, time, and evidence.
- Authorization evidence is displayed and referenced by the deterministic discrepancy.
- Agent station proposes one `request_reprocessing` action and message artifact.
- Deny and Allow once paths follow the product spec.
- Allow once creates an artifact, receipt, next follow-up, Provenance, and AuditEvent.
- Adjudication never becomes paid as a side effect.

Expected change points:

- Discrepancy engine and resolution policy
- Synthetic agent adapter with the normalized event envelope
- Proposal, artifact preview, approval controls, activity stream
- Approval executor and follow-up scheduler

### Slice 5: downstream and payment semantics

Outcome:

- Accepted-no-ERA is follow-up due.
- Rejected and pended fixtures appear in correct stages.
- Only matching remittance plus posting makes Verified paid.
- Missing remittance and missing posting negative cases stay unverified.

Expected change points:

- Stale follow-up rule
- Payment reconciliation selector
- Timeline and KPI regression coverage

### Slice 6: real adapter boundaries

Status: Implemented for mock-testable read/execute boundaries (repair `pms-repair-2`). Live credentials remain optional. BFF DTOs match Breakfast Factory v1 (`client_request_id` / `prompt` / `event_type`). Medplum projections are Bundle-derived only and drive the connected view model.

Outcome:

- Healthcare mode is exactly `local` or `medplum`.
- Agent mode is exactly `synthetic` or `bff`.
- Server-only config is validated.
- Missing config and connection failure show explicit degraded state with no silent fallback.
- Medplum adapter maps the same application read model and keeps raw 277/835 limitations explicit.
- BFF adapter exposes normalized thread/run/SSE events with durable cursor and duplicate removal.

Expected change points:

- Server-only config
- Adapter interfaces and local implementations
- Medplum repository skeleton and optional seed or smoke command
- BFF client, narrow proxy, SSE normalization, sanitized errors

Actual connected writes are not required without credentials. The adapter must be honest and testable at its boundary.

### Slice 7: hardening and demo evidence

Outcome:

- Full 5-minute scenario passes in Chromium.
- 1280px desktop layout keeps table, workbench, and agent panel usable.
- Refresh, duplicate approval, Reset, connected-adapter failure, and secret canary pass.
- README documents run commands, demo script, synthetic boundaries, and optional adapter configuration.

## Architecture invariants

- A single product claim status is forbidden.
- Every external observation is immutable and carries source, raw value, normalized value, timestamp, and evidence reference.
- The primary funnel is mutually exclusive; overlay flags are independent.
- Submitted requires a transmission receipt.
- Reprocessed is not paid.
- Verified paid requires matching remittance and reconciled PMS posting.
- BFF output cannot mutate healthcare state directly.
- Approval is scoped to action, target, payload digest, and episode revision.
- Retry reuses the idempotency key.
- Connected adapter failure never falls back silently.
- No real PHI, external payer write, or interview asset enters the project.
- Credentials stay server-side and never use `NEXT_PUBLIC_`.

## Acceptance matrix

| ID | Observable requirement | Verification method | Expected observation | Evidence needed |
|---|---|---|---|---|
| A01 | Synthetic practice opens immediately | Browser open `/dashboard` | PMS shell, Synthetic data, healthcare and agent mode badges | Screenshot and trace |
| A02 | Visit KPI and primary funnel are correct | Selector unit test and browser assertion | Today and month visits plus fixture-derived funnel | Raw test output and screenshot |
| A03 | Overlay does not pollute funnel | Projection table test | Primary bucket count equals episode count; overlays separate | Raw test output |
| A04 | Operational queues are visible | Browser assertion | Agent approvals and Exceptions and follow-up queues contain expected fixtures | Screenshot |
| A05 | Four required routes work | Browser route test | Dashboard, encounters, claims, workbench navigation succeeds | Trace and screenshots |
| A06 | Preflight evidence is explicit | Browser encounter flow | Completed encounter, final note, coverage, provider, code, charge checks shown | Screenshot and fixture reference |
| A07 | Proposal does not write | State comparison contract test | Transport and adjudication observations unchanged | Raw test output |
| A08 | Submission Deny is safe | Browser and event assertion | No Claim, receipt, submitted observation, or follow-up is created | Trace and event snapshot |
| A09 | Submission Allow once works | Browser flow | Receipt and audit created; Ready decreases and Submitted increases | Before and after screenshots and events |
| A10 | Submission is idempotent | Duplicate route request | Same receipt; one execution event | Raw test output |
| A11 | Claim C discrepancy is visible | Unit rule and browser workbench | PMS processing and payer denial shown with source, time, evidence | Screenshot and raw test output |
| A12 | Proposal cites authorization evidence | Browser agent panel | Reprocessing message cites the linked authorization evidence | Screenshot and proposal JSON |
| A13 | Reprocessing Deny is safe | Isolated browser flow after Reset | External state, artifact, receipt, and follow-up unchanged | Trace and event snapshot |
| A14 | Reprocessing Allow once works | Isolated browser flow | Artifact, receipt, follow-up, Provenance, AuditEvent created | Screenshot and artifact snapshot |
| A15 | Reprocessed is not paid | Projection test | Claim C stays denied or waiting and is absent from paid KPI | Raw test output |
| A16 | Accepted-no-ERA becomes due | Controlled-clock unit and browser test | Fixture appears in follow-up queue | Raw test output and screenshot |
| A17 | Verified paid requires two proofs | Positive and negative unit cases | Only remittance plus matching posting is verified | Raw test output and workbench screenshot |
| A18 | Refresh and Reset are reproducible | Browser reload and Reset | Mutation persists through refresh; Reset restores initial KPI and queue | Trace and before and after screenshots |
| A19 | FHIR and demo origin are honest | FHIR validation and copy assertions | Fixtures valid; raw and synthetic projection labels visible | Validation output and screenshot |
| A20 | BFF failure boundary is explicit | Adapter contract and browser failure mode | BFF mode error is visible; no synthetic fallback or action execution | Raw test output and screenshot |
| A21 | Credentials are absent from browser | Canary build and response scan | Canary absent from client chunks, HTML, JSON, and error bodies | Raw scan output |
| A22 | Production and browser gate pass | Aggregate verify command | All required commands exit 0 | Raw command log and Playwright report |

## Commands

The scaffold must expose these stable scripts:

```bash
npm run typecheck
npm run lint
npm run validate:fhir
npm run test:unit
npm run test:contract
npm run test:replay
npm run build
npm run test:e2e
npm run test:secrets
npm run verify
```

Optional connected mode, only when credentials are explicitly configured:

```bash
npm run seed:medplum
npm run test:medplum
```

## Security and failure checks

- Malformed raw response stays as unmapped evidence and creates a normalization exception.
- Late-arriving observation does not erase newer evidence.
- Stale approval returns 409.
- Duplicate approval returns the existing receipt.
- Ambiguous submission outcome remains pending verification.
- Stream reconnect never approves or executes an action.
- Corrupt local event input fails closed and exposes Reset recovery.
- Reset never deletes Medplum resources.
- AuditEvent is append-only in application behavior.

## Stop conditions

Stop and request user direction if implementation requires:

- Real PHI or a real customer account
- A live claim, payer message, appeal, fax, or payment write
- Deletion of existing user data or connected Medplum resources
- An undocumented FHIR field, extension, search parameter, or medical code
- Browser exposure of Medplum or BFF credentials
- Presenting bank settlement mismatch as interview-confirmed evidence

## Preserved scope

Do not modify these sibling products:

- Overturn app
- Overturn desktop
- Breakfast Factory
- A separate local Medplum source checkout
- Interview source directories and images

Only the hackathon directory is writable for generation.
