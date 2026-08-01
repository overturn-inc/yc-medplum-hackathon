# Agent-native PMS product specification

Status: Approved for implementation

Plan version: v1

## 제품 정의

> 환자 방문에서 claim 제출, payer 상태 확인, source discrepancy 탐지, 해결 실행, remittance posting까지 이어지는 AI-native practice management workspace.

주 사용자는 practice biller 또는 operations staff다. 익숙한 PMS shell을 제공하지만 차별점은 dashboard 자체가 아니라 여러 시스템에서 멈춘 claim을 agent가 발견하고, 근거를 대조하고, 승인 가능한 다음 action으로 끝까지 이동시키는 것이다.

## 메인 데모

PMS에는 `Processing`으로 남아 있지만 최신 payer observation은 `Denied: authorization required`인 claim을 보여준다. Agent는 서비스일을 포함하는 기존 authorization evidence를 찾아 denial과 충돌함을 설명하고 payer reprocessing message를 작성한다. 사용자가 `Allow once`를 눌러야만 message artifact, execution receipt, next follow-up, provenance와 audit event가 생성된다.

이 흐름은 여러 인터뷰에서 확인한 문제를 결합한 synthetic composite다. 실제 payer portal 또는 실제 patient data를 사용하지 않는다.

## 사용 원칙

- Evidence first: Agent 결론보다 source, timestamp, raw status를 먼저 보여준다.
- One claim, many states: 방문, 제출, adjudication, remittance, posting을 단일 status로 합치지 않는다.
- Exception-driven work: 정상 claim은 조용히 흐르고 사람은 discrepancy, missing evidence, approval만 처리한다.
- Human-controlled writes: 외부 write 성격의 action은 exact payload에 대한 일회성 승인을 소비한다.
- Honest demo: synthetic payer data와 실제 adapter 상태를 항상 표시한다.
- Cash claim 금지: `Verified paid`는 bank settlement가 아니라 matching remittance와 PMS posting이 확인됐다는 뜻이다.

## 정보 구조

### Primary navigation

- Overview
- Encounters
- Claims
- Work Queue
- Payments
- Agent Activity
- Approvals
- Reports
- Integrations

MVP에서 실제 동작하는 route는 네 개다. 나머지는 navigation context로 표시하되 disabled 또는 명확한 후순위 상태로 둔다.

### `/dashboard`

Practice overview.

KPI:

- Visits today
- Visits this month
- Ready to submit
- Submitted or in flight
- Awaiting payer
- Needs attention
- Verified paid MTD

Claim funnel은 상호배타적이다.

- Needs claim
- Ready to submit
- Rejected before adjudication
- Awaiting payer
- Action required
- Denied under resolution
- Paid needs posting
- Reconciled or closed

Overlay KPI는 중첩 가능하다.

- Follow-up due
- Source discrepancy
- Approval required

두 queue:

- Agent approvals
- Exceptions and follow-up

KPI와 queue row는 해당 filter 또는 claim workbench로 이동한다.

### `/encounters`

Encounter queue.

필드:

- Patient
- Date of service
- Provider
- Coverage
- Encounter state
- Note state
- Coding readiness
- Charge
- Billing state

Filter:

- Ready to bill
- Missing information
- Claim created

Ready encounter를 열면 claim preflight를 표시한다. Preflight에는 completed encounter, final note, active coverage, provider, diagnosis, service line, charge 검사가 있어야 한다. Proposal을 만든 것만으로 submitted 상태가 되지 않는다.

### `/claims`

Claim lifecycle queue.

필드:

- Patient
- Claim ID
- Date of service
- Payer
- CPT
- Billed amount
- Primary bucket
- PMS state
- Clearinghouse state
- Payer state
- Remittance and posting state
- Age
- Last payer check
- Next follow-up
- Issue
- Agent action
- Owner

Filter:

- Draft
- Submitted
- Rejected
- Accepted
- Processing
- Pended
- Denied
- Paid
- Discrepancy
- Needs approval
- Follow-up due

### `/claims/[id]`

Claim workbench.

Header:

- Synthetic patient
- Payer
- Billed amount
- Primary bucket
- Agent resolution state
- Last verified time

Main content:

- Encounter와 patient context
- Claim header와 CMS-1500 계열 service line data
- `Encounter → Claim → Clearinghouse → Payer → Remittance → Posting` lifecycle
- 각 source observation의 raw status, normalized status, timestamp, evidence reference
- Financial reconciliation: billed, allowed, paid, adjustment, patient responsibility, posted
- Evidence drawer

Agent station:

- What I found
- Evidence used
- Proposed action
- Artifact preview
- Allow once 또는 Deny
- Activity stream
- Next follow-up

## Synthetic fixture set

초기 상태는 7개 claim episode projection을 만든다.

| Fixture | 초기 상태 | 목적 |
|---|---|---|
| Encounter A | Completed, note final, active coverage, claim 없음 | Claim preflight와 제출 |
| Claim A | Draft | Draft row와 ready queue |
| Claim B | Payer accepted 이후 response overdue | Follow-up due |
| Claim C | PMS processing, payer authorization denial | 메인 discrepancy와 reprocessing |
| Claim D | Clearinghouse member mismatch rejection | Pre-adjudication rejection |
| Claim E | Payer pended, supporting note missing | Waiting on practice |
| Claim F | ERA received, matching PMS posting reconciled | Verified paid |

모든 이름, ID, payer reference, amount, note와 artifact는 새 synthetic value를 사용한다.

## 상태 모델

필수 축:

- Encounter: scheduled, arrived, completed, note signed
- Charge: uncoded, coding blocked, ready, claim created
- Transport: unsent, sent, clearinghouse received, clearinghouse rejected, payer delivered
- Adjudication: not found, accepted for processing, pending, info requested, denied, partial, paid
- Remittance: none, expected, received
- Settlement: unknown, pending, received, failed
- Posting: unposted, posted, reconciled, mismatch
- Resolution: monitoring, investigating, waiting on practice, waiting on payer, approval required, corrected, rebilled, reprocessing, appealed, closed

`Claim.status`는 FHIR resource lifecycle이며 제품 전체 상태가 아니다.

## Discrepancy rules

### `status_conflict`

최신 PMS observation과 더 최신 payer observation의 normalized adjudication이 충돌한다.

### `status_stale`

Accepted 또는 processing 이후 payer 또는 practice별 next follow-up date가 지났지만 새 payer 또는 remittance observation이 없다.

### `payment_unverified`

Payer 또는 ERA evidence는 paid를 나타내지만 linked remittance normalization 또는 posting reconciliation이 없다.

모든 rule은 deterministic하며 어떤 두 source와 어떤 timestamp를 비교했는지 UI에 표시한다.

## Agent 동작

1. Read: 현재 episode에 직접 연결된 evidence만 읽는다.
2. Explain: source가 각각 무엇을 말했고 어떤 expected event가 누락됐는지 설명한다.
3. Propose: 현재 evidence에 맞는 다음 action 하나를 제안한다.
4. Draft: corrected claim diff, payer message, information request, appeal packet 중 필요한 artifact만 만든다.
5. Approve once: action type, target, payload digest, episode revision에 묶인 승인을 받는다.
6. Execute: idempotency key와 함께 adapter를 호출한다.
7. Verify: receipt를 evidence로 남기고 next follow-up을 만든다.

자동 허용:

- Read
- Compare
- Explain
- Draft
- Schedule proposal

승인 필수:

- Claim submit 또는 resubmit
- Corrected claim
- Payer reprocessing request
- External documentation send
- Appeal submit
- Payment posting

## 메인 scenario behavior

### Claim C 초기 상태

- PMS observation: processing
- Clearinghouse observation: payer accepted
- Payer observation: denied, authorization required
- Evidence: service date를 포함하는 authorization-not-required decision reference
- Resolution: investigating

### Proposal

Agent는 다음을 보여준다.

- source discrepancy rule
- 비교한 source와 timestamp
- authorization evidence reference
- payer denial reason
- proposed `request_reprocessing` action
- payer message artifact preview

### Deny

- Proposal decision event만 기록한다.
- External source observation, artifact, receipt, follow-up은 만들지 않는다.
- Claim adjudication은 denied로 남는다.

### Allow once

- Approval receipt를 소비한다.
- Payer message artifact를 만든다.
- Synthetic connector execution receipt를 만든다.
- Follow-up Task를 예약한다.
- Provenance와 AuditEvent를 만든다.
- Resolution은 waiting on payer 또는 reprocessing으로 이동한다.
- Adjudication은 denied 또는 pending reprocessing으로 남으며 paid로 이동하지 않는다.

## Submission behavior

- Encounter A에서 preflight를 열 수 있다.
- 모든 필수 check가 표시된다.
- Proposal 생성은 write가 아니다.
- Deny는 Claim과 submission receipt를 만들지 않는다.
- Allow once는 Claim, synthetic submission receipt, transport observation, audit event를 만든다.
- Submission receipt가 있어야 Submitted KPI에 집계한다.
- 동일 idempotency key retry는 같은 receipt를 반환하고 event를 중복 생성하지 않는다.

## Verified paid behavior

Verified paid는 다음이 모두 맞을 때만 참이다.

- Claim control number 또는 episode identity가 remittance와 일치
- Remittance evidence가 존재
- Paid amount와 posting amount가 허용된 계산 규칙 내에서 일치
- PMS posting evidence가 존재
- Posting state가 reconciled

Payer-reported paid, submitted, accepted, reprocessed는 이 조건을 만족하지 않는다.

## Adapter modes

### Healthcare

- `local`: typed FHIR fixture와 append-only local event store
- `medplum`: server-only Medplum client와 synthetic project

### Agent

- `synthetic`: deterministic proposal과 normalized event stream
- `bff`: server-side BFF thread, run, SSE proxy

모드는 UI badge로 명시한다. Connected mode 실패 시 local 또는 synthetic mode로 조용히 fallback하지 않는다.

## Failure behavior

- Medplum unavailable: 명시적인 connected-mode error와 retry
- BFF unavailable: agent panel degraded error와 retry, action 미실행
- Submission timeout: outcome unknown, submitted로 집계하지 않음
- Duplicate webhook: inbound transaction ID 기준 no-op
- Raw response parse failure: evidence 보존, normalization exception 생성
- Stale approval: episode revision 또는 fingerprint mismatch로 409
- Duplicate approval: 기존 receipt 반환, 새 action 미실행
- Interrupted stream: durable cursor로 reconnect, duplicate event 제거
- Refresh: persisted lifecycle event replay
- Reset: local demo session revision만 초기화하며 connected resource를 삭제하지 않음

## 개인정보와 보안

- Synthetic data only.
- 실제 interview screenshot 또는 patient identifier를 복사하지 않는다.
- Medplum과 BFF credential은 server-only module에서만 읽는다.
- `NEXT_PUBLIC_` credential을 금지한다.
- Browser response와 client bundle에 secret을 포함하지 않는다.
- Agent context는 현재 episode의 최소 evidence만 포함한다.
- External write는 approval executor만 수행한다.
- AuditEvent는 workflow projection 대신 security and execution audit에만 사용한다.

## 비범위

- Scheduling과 calendar CRUD
- Clinical note authoring
- Patient portal과 statement
- Live eligibility와 prior authorization 조회
- General-purpose X12 parser
- 실제 payer, Stedi claim, appeal, fax, payment write
- Bank deposit reconciliation
- 모든 payer integration
- Arbitrary agent chat과 범용 tool execution
- Production auth, database, multi-tenant admin
- HIPAA 또는 BAA readiness 주장
- Accounting 또는 GL integration
- 모든 rejection과 denial의 interactive resolution
- Mobile-first UX와 deployment automation

## 5분 데모 스크립트

1. Dashboard에서 visits, ready, awaiting payer, discrepancy, verified paid를 설명한다.
2. Encounter A에서 preflight를 열고 claim submission을 Allow once 한다.
3. KPI 변화와 submission receipt를 확인한다.
4. Discrepancy KPI에서 Claim C로 이동한다.
5. PMS processing과 payer denial, authorization evidence를 나란히 확인한다.
6. Agent가 만든 reprocessing message와 근거를 검토한다.
7. Allow once 후 receipt, artifact, follow-up, activity event를 확인한다.
8. Claim F에서 remittance와 posting이 모두 있어야 Verified paid라는 종료 조건을 확인한다.

## 완료 정의

- Synthetic local mode의 전체 5분 scenario가 setup 없이 반복 가능하다.
- Typecheck, lint, FHIR validation, unit, contract, replay, production build, Playwright E2E, secret canary가 통과한다.
- Refresh와 Reset이 동작한다.
- 실제 connected adapter가 설정된 경우에만 해당 adapter smoke를 추가 필수로 실행한다.
- 연결되지 않은 Medplum, BFF, Stedi 기능을 실행됐다고 표현하지 않는다.
