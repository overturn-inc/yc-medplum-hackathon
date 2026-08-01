# Overturn for YC Medplum Hackathon 2026

Local-first **agent-native PMS** demo: encounter preflight → approval-gated synthetic submission → source discrepancy detection → authorization-backed reprocessing → remittance + posting verified paid.

## Requirements

- Node.js **20.19+**
- npm

## Quick start

```bash
npm install
npx playwright install chromium
npm run dev
```

Open [http://localhost:3000/dashboard](http://localhost:3000/dashboard). No login. Data is synthetic.

## Adapter modes

| Mode | Env | Behavior |
|---|---|---|
| Healthcare `local` (default) | `HEALTHCARE_MODE=local` | Typed FHIR fixtures + append-only `var/demo` event store |
| Healthcare `medplum` | `HEALTHCARE_MODE=medplum` + `MEDPLUM_*` | Connected read path; **no silent fallback** to local |
| Agent `synthetic` (default) | `AGENT_MODE=synthetic` | Deterministic proposals and execution |
| Agent `bff` | `AGENT_MODE=bff` + `BFF_*` | Connected BFF boundary; unavailable = explicit error, action not executed |

Copy `.env.example` to `.env` for local overrides. Credentials are **server-only**. Never use `NEXT_PUBLIC_` for secrets.

## 5-minute demo

1. **Dashboard** — visits, ready, awaiting payer, source discrepancy overlay, verified paid MTD.
2. **Encounters → Avery Quinn** — preflight checks; **Deny** changes nothing; **Allow once** submits synthetically; Ready −1 / Submitted +1.
3. **Claims → Dana Okonkwo (Claim C)** — PMS `Processing` vs payer `Denied: authorization required`, authorization evidence, reprocessing message.
4. **Deny** then **Allow once** — artifact, receipt, follow-up, Provenance, AuditEvent; adjudication stays denied (not paid).
5. **Claim F (Greta Mills)** — ERA + reconciled posting ⇒ **Verified paid**.
6. **Refresh** keeps mutations; **Reset demo** restores seed without deleting connected resources.

## Verification

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
npm run verify   # all of the above
```

Optional (credentials required, not part of default verify):

```bash
npm run seed:medplum
npm run test:medplum
```

## Synthetic limitations

- All patients, payers, authorizations, portal snapshots, 277/835, and messages are **synthetic** in default local mode.
- Realistic denial, portal follow-up, and reprocessing are demo connectors — not live payer writes.
- `Verified paid` means matching remittance **and** reconciled PMS posting. It is **not** bank settlement.
- No general X12 parser, auth system, database, or full PMS scope.
- Approval is bound to `proposalId`, `payloadDigest`, `episodeRevision`, and fingerprint. After success, retries require the identical scope; missing or tampered scope returns HTTP 409 with no receipt.
- Deny clears the proposal and `approval_required`. Reconsideration needs an explicit new proposal.
- Local `events.ndjson` is the append-only source of truth (with `episode.projected` reducers). `snapshot.json` is an atomic cache. Corrupt ledgers are quarantined on Reset.
- Connected BFF/Medplum adapters are mock-testable HTTP clients. Default verify never requires live credentials.

## Current Medplum 277/835 limitation

Current Medplum Stedi response integration stores raw 277 and 835 as `DocumentReference` and does **not** automatically create normalized adjudication `ClaimResponse` or `PaymentReconciliation`. This demo’s normalizer/discrepancy layer sits above that boundary using synthetic evidence in local mode.

## Product docs

- [Product spec](docs/product-spec.md)
- [Data and agent architecture](docs/data-agent-architecture.md)
- [Implementation plan / A01–A22](docs/implementation-plan.md)
