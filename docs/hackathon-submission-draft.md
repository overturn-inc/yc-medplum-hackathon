# Hackathon submission draft

Official event and form rechecked on 2026-08-01. Submissions close at 5:00pm PT
and the form allows one submission per team.

## Judging criteria — product decision source of truth

1. **Potential impact:** The hack should meaningfully improve patient care,
   clinician experience, or quality of care. It should be intelligent,
   standards-compliant, automated, and optionally voice-enabled while reducing
   clinician and practice-staff workload rather than adding to it.
2. **Effective use of provided technologies:** Judges evaluate how well the hack
   uses Deepgram, Medplum, moss.dev, and/or Stedi.

Decision rule: a sponsor technology counts only when it performs a visible,
necessary job in the end-to-end claim workflow. Do not add logo-only integrations
or claim a live connection that the demo does not execute.

## One-liner

Overturn is an agent-native PMS workbench that detects multi-source claim
discrepancies, explains the current state with episode-scoped evidence, and
requires one-time human approval before any synthetic write.

## Hack name and tagline

**Overturn — An agent-native claims desk that follows every claim from visit to verified payment.**

## Problem statement

Medical billers work across a PMS, clearinghouse reports, payer portals, 277
status messages, 835 remittances, and posting records. Those sources often
disagree, so billers manually re-check status, distinguish rejections from
denials, prepare corrections or reprocessing requests, and verify that payment
was actually posted. Overturn turns that fragmented follow-up into one
evidence-backed workspace with approval-gated actions.

## Sponsor technology answer

- **Medplum:** The data plane is modeled with FHIR R4 resources including
  Encounter, Claim, ClaimResponse, Coverage, DocumentReference, Task,
  PaymentReconciliation, Provenance, and AuditEvent. The connected Medplum
  adapter reads claim-scoped resources and fails closed when credentials or
  evidence are missing. The public demo uses synthetic FHIR fixtures because no
  live Medplum project credentials are configured.
- **Stedi:** The deployed demo executes a real Stedi 270/271 eligibility API call
  with Stedi's approved synthetic Jane Doe record, surfaces the live test-mode
  result in claim preflight, and keeps the API key server-only. For the
  guided hero claim, only that normalized result (test mode, active coverage,
  benefit count, never the raw X12) is persisted as durable episode evidence,
  is idempotent (never re-called once on file), and is rate-limited. The
  837P, 277CA, and 835 claim rail -- including the hero claim's submission --
  is represented as a simulated clearinghouse rail; it cannot execute with
  the current Sandbox account, which authorizes eligibility only. Appeal is
  demonstrated separately against the fictional Northstar payer portal.
- **Deepgram:** The guided hero claim (Encounter A) now calls Deepgram from a
  dedicated automation sidecar as one step of its denial-follow-up flow: a
  fixed-action voice-session tool job produces a transcript, structured facts
  (denial reason code, next step), and a durable connector receipt that
  advances the claim's hero stage. It runs over scripted synthetic payer
  audio -- there is no PSTN/phone dialing anywhere in this demo, live or
  mock. Live Deepgram requires the sidecar's own `DEEPGRAM_API_KEY`; without
  it, an in-process mock sidecar returns the same shaped receipt so the
  guided flow, tests, and CI never require a live key. An earlier real
  Twilio phone call through the Deepgram Voice Agent API (Flux speech
  recognition, Aura-2 synthesis) was validated locally with synthetic Claim C
  context; that PSTN path is not part of the product workflow above.
- **Moss.dev:** The product creates a dedicated 39-document synthetic claims
  index and performs real claim-scoped semantic retrieval inside the agent
  station. Claim C visibly shows the retrieved denial, authorization, 277, and
  reconciliation sources with similarity scores and latency. The same retrieval
  boundary is designed for the phone agent: only metadata-matched documents for
  the current episode survive the server-side scope guard. A live SDK validation
  loaded the cloud index and completed warm local in-memory search in 7.8ms. The
  public Worker now calls an authenticated Node sidecar on AWS, which uses the
  official SDK for the same local search while keeping the Moss project key out
  of the Worker and browser.

The public demo also uses the live Breakfast Factory agent backbone through its
AWS acceptance environment for conversational intent classification. Grounding,
proposal construction, approvals, and synthetic healthcare receipts remain
server-owned so a model completion cannot be mistaken for a payer write.

## Links

- Public demo: https://overturn-agentic-claims.argentum1450.chatgpt.site
- Code repository: pending GitHub authentication; the form marks this optional.
- YouTube video: owner upload required.

## What judges see

1. Synthetic practice dashboard with seven encounter/claim episodes and always-on
   synthetic / no-live-payer-write badges.
2. Encounter A's guided hero claim: a live Stedi 270/271 eligibility check,
   simulated submission, deterministic follow-through, a Northstar portal
   investigation and Deepgram voice-session tool job (both against the
   automation sidecar), approval-gated reprocessing, a denial recheck, and a
   formal appeal with a Northstar confirmation number -- every step backed by
   a durable connector receipt or approval, never a silent state jump.
3. Conversational agent station per claim: status, reason, evidence, next action,
   and proposal-only action requests.
4. Claim A approval-gated submission ending at clearinghouse
   received with adjudication not found.
5. Claim B overdue payer status refresh (read-only; never marks paid).
6. Claim C PMS-versus-payer authorization discrepancy with Deny, Re-propose, and
   Allow once reprocessing evidence, plus live Moss matches and latency.
7. Claim D clearinghouse rejection corrected resubmission that preserves the
   original claim and updates queues.
8. Claim E send of an existing signed supporting note after approval.
9. Claim F verified paid only when independent remittance and PMS posting
   evidence agree on claim/control and amounts.

## Honest boundaries

- Default demo is fully synthetic. No real PHI.
- The public Breakfast Factory BFF adapter is live and validated against its AWS
  acceptance environment. The Medplum adapter is mock-tested and no live Medplum
  credentials are claimed.
- BFF `run_completed` proves model completion only, never payer mutation success.
- Domain connector receipts alone prove mutation success.
- No claim of a live Stedi 837P/277CA/835 transaction, real Medplum credentials,
  PMF, or live payer writes. Moss retrieval is live in the public product against
  a synthetic-only index through the authenticated AWS sidecar.
- The guided hero claim's Deepgram voice session and Northstar portal
  automation run against a dedicated sidecar that falls back to an
  in-process mock when no live credentials are configured, so the demo,
  tests, and CI never silently require them. No PSTN/phone dialing exists
  anywhere in this demo -- voice sessions run over scripted synthetic payer
  audio, live or mock. Medplum FHIR write-through for the hero claim's
  Provenance/AuditEvent is additive and optional: session state and hero
  stage progression never depend on it succeeding.

## Verification

`npm run verify` runs typecheck, lint, FHIR validation, unit, contract, replay,
database, build, Playwright, and secret scanning.

The public mutation E2E also passes submission, payer refresh, denial
reprocessing, clearinghouse correction, documentation response, verified-paid
safety, agent post-action status, persistence, session isolation, and reset. The
deployed version passed three consecutive runs while asserting `Agent: bff`.

## Suggested 3-minute video

1. 0:00-0:20 — Problem and dashboard: explain source fragmentation and synthetic mode.
2. 0:20-0:55 — Encounter A: submit with Allow once, then ask the agent for current status.
3. 0:55-1:30 — Claim D: explain clearinghouse rejection versus payer denial; correct member ID and resubmit.
4. 1:30-2:05 — Claim C: ask for evidence, show Moss sources/latency, then deny and re-propose, approve reprocessing, and ask status again.
5. 2:05-2:30 — Claim B and E: approval-free read-only refresh and documentation response.
6. 2:30-2:50 — Claim F: independent 835 and PMS posting evidence for verified paid.
7. 2:50-3:00 — Medplum FHIR architecture, public URL, and honest synthetic boundary.

## Submission-owner fields still required

- Team members' names and emails
- Phone number
- YouTube upload link and view count at submission time
- One form submission before 5:00pm PT

The official form requires email, team name, team member names and emails, phone
number, hack name and tagline, problem statement, sponsor-technology usage,
YouTube link, and YouTube view count. The code repository link is optional.

## Final judging-readiness assessment

- **Potential impact:** Strong demo fit. The product reduces biller follow-up work,
  distinguishes transport rejection from payer denial, keeps evidence and current
  state claim-scoped, and prevents unapproved external writes.
- **Effective use of provided technology:** The code has a validated FHIR R4 data
  model and a fail-closed Medplum adapter, but the public release is not connected
  to a live Medplum project. Stedi now executes a real test-mode 270/271 request;
  the claim rail remains blocked by the current Sandbox account entitlement.
  Moss now performs real product-integrated retrieval from a dedicated synthetic
  corpus; its Node path has been live-validated with local in-memory search.
- **Cannot be completed autonomously:** A live Medplum connection requires a
  project plus server-side client credentials supplied by the team. A YouTube
  upload and the final form also require the team owner's account and personal
  fields.
- **Deadline:** Saturday, August 1, 2026. Submissions close at 5:00pm PT;
  presentations begin at 6:00pm PT and awards are at 7:00pm PT.
