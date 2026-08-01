# Demo completion approved plan v1

State: PLAN_READY

Approved by: Main agent after Planner review

Authoritative completion contract:
`docs/pgv/demo-completion-execution-manifest-v1.md`

## Frozen product decisions

1. Extend `episode-encounter-a` into the single guided hero claim from visit to
   appeal. Preserve the existing Claims A-F and their direct paths.
2. Use a fictional payer named `Northstar Payer Services Demo`. Do not copy a real
   payer's trademark, login or protected visual identity.
3. Run real Playwright browser work in an authenticated AWS automation sidecar.
   Expose only the fictional portal UI publicly; keep job control authenticated.
4. The browser contract accepts only fixed action identifiers and server-owned
   synthetic inputs. It never accepts arbitrary URL, selector, script, member,
   patient or claim values from a client.
5. Use real Deepgram prerecorded STT plus Aura TTS over repository-owned synthetic
   payer audio. Label it `Live Deepgram voice session`, `scripted synthetic payer
   audio`, and `no phone dialed`. Do not expose public Twilio dialing.
6. Use Stedi only for the fixed approved synthetic Jane Doe eligibility request.
   Public users cannot supply eligibility fields. Claim transport remains clearly
   labeled `Simulated Stedi clearinghouse rail` because 837P is not entitled.
7. Keep D1 as the anonymous session and event ledger. Add Medplum as an idempotent
   FHIR write-through and read-back plane rather than replacing D1.
8. External state changes advance only after a connector receipt. BFF completion,
   browser progress, transcript text or a click is never sufficient.
9. Appeal execution starts only after one-time approval and finalizes only after a
   unique fictional portal confirmation. Duplicate approval and retry reuse the
   same result.
10. Moss v2 adds portal, voice and appeal-policy documents without names or member
    IDs. Results remain episode scoped and are cited only when the referenced
    evidence already exists on the episode.
11. Every long action returns queued progress within one second, has a terminal
    success or explicit failure, and prevents double submission.
12. All schema changes are additive. Old public sessions and Claims A-F must replay.

## Approved ordered implementation slices

### Slice 1 — Additive job and hero state foundation

- Add an additive D1 migration for tool jobs, ordered tool events, connector
  receipts/proof metadata and rate-limit windows.
- Define job states `reserved`, `queued`, `running`, `pending_verification`,
  `completed`, `failed_safe`, and `cancelled` with strict schemas.
- Bind each job to session identity, session revision, episode, episode revision,
  action and idempotency key.
- Extend hero state through submitted, accepted overdue, portal denied, voice
  evidence collected, reprocessing, denial upheld, appeal ready, appeal submitted.
- Preserve existing event replay. Reject stale results after reset or revision
  change.
- Make reset cancel active jobs first and return 409 if cancellation cannot be
  confirmed.

### Slice 2 — Fictional payer portal and automation sidecar

- Add `services/automation-sidecar` with a public fictional payer portal and a
  private authenticated job API.
- Use Playwright for `investigate_claim`, `recheck_reprocessing`, and
  `submit_appeal` only.
- Store deterministic portal state and idempotent confirmations locally in the
  sidecar. Keep proof screenshots and generated audio on a TTL-managed volume.
- Enforce origin, redirect and request allowlists, concurrency limits, 90-second
  hard timeout, authenticated create/status/cancel/proof routes and guaranteed
  browser context cleanup.
- Return 401 for missing auth, 400 for unknown actions, the existing job for
  duplicate keys, and `pending_verification` for ambiguous submission outcomes.
- Provide health, contract and live smoke scripts plus non-root container and AWS
  deployment assets.

### Slice 3 — Real Deepgram synthetic voice session

- Add repository-owned synthetic payer audio without real PHI.
- Send it through the live Deepgram prerecorded STT API.
- Extract only an allowlisted set of claim-status facts deterministically.
- Generate the Overturn response with live Aura TTS.
- Persist transcript, extracted facts, provider request identifiers, duration,
  model names and audio proof as the hero claim's evidence.
- Apply session and global rate limits, timeout, cancel, duplicate suppression and
  explicit provider-error states. Keep the Deepgram key in AWS Secrets Manager and
  the sidecar only.

### Slice 4 — Tool job service and application APIs

- Add a server-owned ToolJobService that validates episode state and action before
  calling the sidecar.
- Add fixed-action create, poll, cancel and proof/audio proxy routes.
- Recheck session and episode revision on create, poll and finalize.
- Persist ordered progress and receipts to D1. Apply episode mutation only once the
  expected connector receipt is verified.
- Start client polling at 500ms and relax to one second. Never expose sidecar auth,
  Deepgram credentials or storage paths.

### Slice 5 — Public Stedi eligibility with durable evidence

- Reuse the fixed Jane Doe 270 request and existing Stedi adapter.
- Persist a normalized receipt, evidence and activity event idempotently. Do not
  store raw X12; retain only check ID, test mode, raw-271-present flag, active
  coverage and benefit summary.
- Enforce a small per-session and global rate cap that reset cannot erase.
- Add a contract test proving no Stedi claim endpoint is called.
- Keep all claim submission copy and receipts explicitly simulated.

### Slice 6 — Guided follow-through, reprocessing and appeal

- Preserve Encounter A's current claim submission behavior.
- Add a deterministic follow-through transition that generates accepted and
  overdue evidence.
- Require a completed browser investigation and Deepgram voice receipt before
  reprocessing can be proposed.
- Require a completed denial-upheld browser recheck before appeal can be proposed.
- Add `submit_appeal` to proposal builders, action policy and executor.
- Build the packet from exact denial, authorization, 277, portal, voice,
  reprocessing and upheld references.
- Deny records only the decision. Allow queues the browser job but does not consume
  the approval until confirmation. Finalization creates one artifact, receipt,
  follow-up, appealed state, Provenance and AuditEvent.
- Preserve the portal receipt if downstream Medplum synchronization fails and
  reconcile without resubmitting the appeal.

### Slice 7 — Moss v2 episode-grounded evidence

- Extend the deterministic Moss corpus with hero portal, voice and appeal-policy
  documents and no names or member IDs.
- Create a new v2 index and keep v1 for rollback.
- Reject cross-episode results and citations whose evidence reference is not yet on
  the durable episode.
- Verify that portal and voice citations appear only after their connector receipts.

### Slice 8 — Medplum FHIR write-through

- Split session-ledger selection from FHIR-plane selection in server composition.
- Add idempotent synthetic FHIR write/read-back for Claim, ClaimResponse, Task,
  DocumentReference, Provenance and AuditEvent.
- Derive FHIR IDs from a non-reversible session/revision hash, never a raw cookie.
- Validate resources locally and on Medplum. Resynchronize the same IDs after a
  partial failure and never repeat an external portal action.
- Display separate badges for `Session ledger: D1`, `FHIR plane: Medplum connected`
  and `Payer writes: simulated`.
- Implement mock and live scripts. Live completion remains blocked until valid
  `MEDPLUM_*` credentials for a synthetic project are available.

### Slice 9 — Guided UI and progress

- Add a dashboard hero stepper for Encounter A with one primary CTA per current
  stage.
- Add a reusable ToolJobPanel showing queued/running steps, screenshot proof,
  transcript, extracted facts, TTS audio, provider receipt, retry/cancel and
  terminal status.
- Announce progress through ARIA live and prevent double submission.
- Add explicit BFF progress phases such as contacting, grounding and preparing,
  with timeout and retry rather than an indefinite frozen button.
- Preserve the established shell, responsive sidebar, claim workbench and Claims
  A-F direct controls.

### Slice 10 — Tests, security, docs and deployment assets

- Add unit, contract, replay, D1, FHIR, sidecar and browser tests covering A01-A15.
- Extend local E2E and public E2E with the complete hero path and timed progress
  assertions while retaining all existing cases.
- Add live Stedi, Deepgram, automation and Medplum scripts. Live scripts must never
  print secrets or real identifiers.
- Extend secret scan and public-repo audit for all new credentials, audio/proof
  artifacts and absolute paths.
- Update README, architecture, deployment runbook, submission draft and validation
  evidence with exact honest boundaries.
- Add non-root container, resource caps, integrated Caddy routing, AWS deploy,
  readiness, ECR scan and rollback assets.
- Keep `.openai/hosting.json` project ID, D1 binding and R2 setting unchanged.

## Generator-owned files and components

The Generator owns every file under `dev/yc-medplum-hackathon` needed for the
approved slices, including new files. It must not edit outside that directory. The
Main-authored files under `docs/pgv/` are authoritative inputs and must not be
rewritten except to add implementation evidence links if strictly necessary.

## Generator checks

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
```

The Generator must add and run focused checks for automation, Deepgram, Stedi,
Medplum and the hero journey where credentials and local infrastructure allow. It
must report credential or network blockers as blockers rather than faking results.

## Deployment plan owned by Main after generation

1. Inspect the complete diff and rerun the aggregate local gate.
2. Build, scan and deploy the automation sidecar to the existing AWS BFF host after
   verifying Chromium capacity and integrated Caddy rollback.
3. Seed and validate Moss v2, then switch the sidecar index while retaining v1.
4. Run live Deepgram and Stedi synthetic smoke.
5. Obtain Medplum synthetic-project credentials, seed, write and read back resources.
6. Set server-only Sites environment values. Never place Deepgram keys in Sites if
   the automation sidecar owns Deepgram execution.
7. Generate and inspect one site-specific social card after the UI and copy freeze.
8. Run the complete build, commit and push the exact source, package the same SHA,
   save and deploy a Sites version, then run the public A01-A16 smoke.
9. Retain the previous Sites version, sidecar image, Caddy backup and Moss v1 as the
   rollback set.

## Implementation stop conditions

- Stop rather than claim A11 if Medplum credentials remain unavailable.
- Stop before adding public PSTN dialing, arbitrary phone numbers, real payer writes,
  real PHI, broad IAM or a destructive migration.
- Stop if the existing AWS host cannot safely run Chromium without new paid capacity.
- Stop if sidecar authentication, allowlist, rate limits, cleanup or image scan fail.
- Stop for Main adjudication when a new core design decision conflicts with this plan.
