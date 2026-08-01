# Validation evidence

Validated: 2026-08-01 (final validator round after `pms-repair-2`)

Final verdict: **FAIL**

The aggregate automated gate passes, but final semantic validation found material
acceptance gaps in A17, A18, and A20. This document records both facts and must
not be read as a release approval.

## Aggregate gate

`npm run verify` exited 0 after repair-2.

| Gate | Result |
|---|---|
| TypeScript | Passed |
| ESLint | Passed |
| FHIR validation | 2 tests passed |
| Unit tests | 7 tests passed |
| Contract tests | 9 tests passed |
| Replay tests | 3 tests passed |
| Next.js production build | Passed |
| Chromium E2E | 5 tests passed |
| Secret canary | Passed across build artifacts plus live HTML, `/api/demo`, approval error, and BFF error bodies |

## Acceptance trace (repair-2)

- A08/A13: Deny clears proposal and `approval_required`; Allow once unavailable until a fresh proposal; no Claim/artifact/receipt/follow-up
- A10: After success, identical scope retry returns the same receipt once; missing or tampered scope returns 409 with no receipt
- A14/A19: Provenance and AuditEvent materialization remains validated
- A18: NDJSON replay reconstructs submit/reprocess after deleting `snapshot.json`; corrupt ledger quarantines on Reset; restarted store healthy
- A20: BFF mocks enforce CreateThreadRequest `{client_request_id}`, CreateRunRequest `{client_request_id,prompt}`, `event_type` terminals, per-run cursor/dedupe, bounded reconnect, ambiguous mutation → `pending_verification`
- Medplum: Bundle-only episode mapping; `getDemoViewModel` uses connected snapshot for KPI/queues/detail (no local seven-fixture success path)
- A21/A22: live secret canary and aggregate verify

## Honest boundary

- Default demo mode is `local` healthcare plus `synthetic` agent execution.
- Connected BFF and Medplum adapters are real server-side HTTP clients covered by mocks; live credentials are optional and not part of default verify.
- Connected healthcare writes remain unavailable without a supported write implementation.
- No real PHI, bank-settlement assertion, or interview artifact is included.

## Final validator findings

- A17: the synthetic paid fixture and connected mapper do not establish
  remittance and PMS posting as independent evidence. `PaymentReconciliation`
  is reused as posting evidence, and connected FHIR payment fields are mapped
  incorrectly.
- A18: JSON syntax corruption is handled, but NDJSON events are cast without
  runtime schema validation. Unknown or incomplete events can enter replay
  without degrading the store.
- A20: BFF request, cursor, dedupe, reconnect, and ambiguous-outcome behavior
  improved, but `RunEventV1` validation still accepts incomplete terminal
  events. The Medplum read query also includes an invalid
  `PaymentReconciliation:patient` reverse include and uses patient-wide evidence
  linkage that can mix claims.

The local synthetic UI is demonstrable. The connected boundaries and verified
payment invariant are not yet accepted as complete.
