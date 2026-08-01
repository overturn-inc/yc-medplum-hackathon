# Hackathon submission draft

Official event and form rechecked on 2026-08-01. Submissions close at 5:00pm PT
and the form allows one submission per team.

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
- **Stedi:** The demo models the 837P submission, 277 status, and 835 remittance
  boundaries with synthetic documents and receipts. It does not claim a live
  Stedi payer transaction or a custom test-mode denial.
- **Deepgram:** Not used.
- **Moss.dev:** Not used.

## Links

- Public demo: https://overturn-agentic-claims.argentum1450.chatgpt.site
- Code repository: pending GitHub authentication; the form marks this optional.
- YouTube video: owner upload required.

## What judges see

1. Synthetic practice dashboard with seven encounter/claim episodes and always-on
   synthetic / no-live-write badges.
2. Conversational agent station per claim: status, reason, evidence, next action,
   and proposal-only action requests.
3. Encounter A / Claim A approval-gated submission ending at clearinghouse
   received with adjudication not found.
4. Claim B overdue payer status refresh (read-only; never marks paid).
5. Claim C PMS-versus-payer authorization discrepancy with Deny, Re-propose, and
   Allow once reprocessing evidence.
6. Claim D clearinghouse rejection corrected resubmission that preserves the
   original claim and updates queues.
7. Claim E send of an existing signed supporting note after approval.
8. Claim F verified paid only when independent remittance and PMS posting
   evidence agree on claim/control and amounts.

## Honest boundaries

- Default demo is fully synthetic. No real PHI.
- Connected Medplum and Breakfast Factory BFF adapters are mock-tested HTTP
  boundaries. Live credentials are optional and not claimed as present.
- BFF `run_completed` proves model completion only, never payer mutation success.
- Domain connector receipts alone prove mutation success.
- No claim of real Stedi denial, real Medplum credentials, Deepgram, Moss, PMF,
  or live payer writes.

## Verification

`npm run verify` runs typecheck, lint, FHIR validation, unit, contract, replay,
database, build, Playwright, and secret scanning.

The public mutation E2E also passes submission, payer refresh, denial
reprocessing, clearinghouse correction, documentation response, verified-paid
safety, agent post-action status, persistence, session isolation, and reset.

## Suggested 3-minute video

1. 0:00-0:20 — Problem and dashboard: explain source fragmentation and synthetic mode.
2. 0:20-0:55 — Encounter A: submit with Allow once, then ask the agent for current status.
3. 0:55-1:30 — Claim D: explain clearinghouse rejection versus payer denial; correct member ID and resubmit.
4. 1:30-2:05 — Claim C: show PMS/payer discrepancy, deny and re-propose, approve reprocessing, ask status again.
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
