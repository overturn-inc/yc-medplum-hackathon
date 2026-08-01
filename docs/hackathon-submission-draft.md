# Hackathon submission draft

## One-liner

Harborview is an agent-native PMS workbench that detects multi-source claim
discrepancies, cites episode evidence, and requires one-time human approval
before any synthetic write.

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
