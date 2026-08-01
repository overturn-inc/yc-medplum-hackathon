# PMS workflow evidence

## 결론

인터뷰가 직접 입증한 핵심 문제는 `PMS에는 paid, 보험사는 unpaid`라는 단일 모순이 아니다. 실제 문제는 PMS, clearinghouse, payer portal, remittance, posting이 각자 다른 상태와 갱신 시점을 가지며, 연결이 끊기면 biller가 여러 화면을 순서대로 방문해 실제 상태를 다시 확인해야 한다는 것이다.

제품은 하나의 `claim.status`를 만들지 않는다. 원본 source observation을 보존하고, source 간 충돌 또는 예상 event의 누락을 별도의 exception으로 계산한다.

## 관찰된 follow-up waterfall

1. PMS에서 완료된 방문과 열린 보험 잔액을 찾는다.
2. Clearinghouse에서 claim이 payer로 전송됐는지 확인한다.
3. Clearinghouse hold 또는 rejection이면 오류를 수정하고 재전송한다.
4. Payer가 claim을 accepted for processing 했는지 확인한다.
5. Accepted 이후 EOB 또는 ERA가 없으면 payer portal에서 환자 이름, 생년월일, member ID로 claim을 찾는다.
6. Portal로 해결되지 않으면 payer에 전화한다.
7. Payment 또는 remittance를 확인한 뒤 PMS에 posting하고 balance를 닫는다.

주요 근거:

- Prabath가 설명한 clearinghouse 확인, payer acceptance, portal 조회, phone-last 순서: `first-10-customers/interviews/2026-07-29-prabath/transcript-agent.md:1560`, `:1612`, `:1652`, `:1664`
- Waseem이 설명한 30일 초과 claim follow-up과 report 누락: `first-10-customers/interviews/2026-07-17-waseem-arif/speaker-turns.md:567`, `:575`, `:607`
- Hamza가 설명한 payer payment 이후 PMS posting: `first-10-customers/interviews/2026-07-12-hamza-ali/transcript-agent.md:427`

## 직접 확인된 discrepancy

| ID | 직접 확인된 상태 | Agent가 해야 할 일 |
|---|---|---|
| E01 | 완료된 방문은 있으나 claim 또는 report에 없음 | 방문, note, charge, claim 존재 여부를 대조하고 작업 생성 |
| E02 | PMS에서는 submitted지만 clearinghouse receipt가 없음 | 전송 receipt를 확인하고 모호한 결과를 제출 성공으로 처리하지 않음 |
| E03 | Clearinghouse hold 또는 rejection으로 payer에 도달하지 않음 | 오류 근거를 표시하고 corrected claim 또는 재전송 제안 |
| E04 | Clearinghouse는 sent-to-payer이나 payer에서 claim을 찾지 못함 | payer handoff를 확인하고 follow-up 예약 |
| E05 | Payer accepted-for-processing 이후 EOB 또는 ERA가 없음 | portal 조회, 결과가 없으면 phone follow-up 제안 |
| E06 | Processing 상태가 practice 또는 payer follow-up 기준을 넘김 | stale exception과 next follow-up 생성 |
| E07 | Payer denial이 eligibility 또는 authorization evidence와 충돌 | 근거를 묶어 reprocessing request 제안 |
| E08 | Reprocessing은 확인됐지만 최종 adjudication 또는 payment가 없음 | paid로 닫지 않고 계속 추적 |
| E09 | Duplicate 또는 previously-paid 응답과 기존 claim/payment 사실이 충돌 | 원 claim, remittance, posting을 대조한 뒤 action 결정 |
| E10 | Outstanding claim에 owner, note, next action이 없어 누락 | work queue exception 생성 |

## 아직 제품 가설인 discrepancy

| ID | 가설 | 데모 처리 |
|---|---|---|
| H11 | ERA에는 paid이지만 실제 EFT 또는 check settlement가 없음 | 실제 인터뷰 사례로 표현하지 않으며 기본 데모 범위에서 제외 |
| H12 | ERA는 수신됐지만 PMS posting이 없거나 line amount가 다름 | synthetic fixture로만 사용하고 `Paid, needs posting`으로 표현 |
| H13 | Corrected claim version이 original과 연결되지 않아 원 claim이 열린 상태 | immutable claim version 관계로 예방 |
| H14 | Waiting 상태에 owner, deadline, next action이 없음 | 운영 불변조건으로 금지 |

## 화면에서 관찰한 정보 구조

비공개 인터뷰 keyframe은 구조 분석에만 사용했고 제품 asset으로 복사하지 않는다. 모든 이름, claim, 금액, payer 데이터는 새 synthetic fixture로 만든다.

### PMS

- 전역 patient/client 검색
- Calendar 또는 Visits
- Unbilled appointments, Claims, Payments
- Claim 목록 필터: 날짜, payer, patient, provider, status
- Claim 목록 열: 생성일, patient, payer, status detail, 제출 후 경과일
- Claim detail: payer와 member, patient와 insured, ICD-10, CPT/HCPCS, modifier, POS, DOS, units, charge, provider

### Clearinghouse

- claim instance와 outbound artifact
- 시간순 source, activity, message
- loaded, passed edits, sent to payer, received, accepted into adjudication, accepted for processing
- payer claim tracking number

### Payer portal

- member ID, DOB, provider/TIN, date range 기반 claim lookup
- eligibility, claim status, prior authorization, rejected/pending claim, reconsideration, appeal queue
- service line, document, appeal ticket와 status

### Remittance

- payer, payee, EFT/check date와 reference
- billed, allowed, paid, adjustment, patient responsibility
- CPT, modifier, service date, remark와 adjustment code

## Dashboard 집계 원칙

Encounter KPI와 Claim Episode KPI의 분모를 섞지 않는다.

상호배타적인 claim funnel:

1. Needs claim
2. Ready to submit
3. Rejected before adjudication
4. Awaiting payer
5. Action required
6. Denied under resolution
7. Paid needs posting
8. Reconciled or closed

중첩 가능한 overlay flag:

- Follow-up due
- SLA breached
- Source discrepancy
- Waiting on practice
- Approval required
- High value

정의:

- `Needs claim`: completed encounter이며 active claim episode가 없음
- `Submitted`: transmission receipt가 있음. Submit click만으로 세지 않음
- `Awaiting payer`: payer accepted-for-processing이며 terminal adjudication이 없음
- `Follow-up due`: nonterminal이며 `next_follow_up_at`이 현재 시각 이전
- `Discrepancy`: source observation이 rule table과 충돌하거나 expected event가 기준 내 누락
- `Rejected`: adjudication 전 rejection
- `Denied`: adjudication 후 denial
- `Paid needs posting`: payment 또는 remittance evidence가 있으나 posting이 reconciled가 아님
- `Closed`: terminal outcome과 필요한 posting 또는 reconciliation이 완료됨

## 해커톤용 합성 시나리오

메인 시나리오는 여러 인터뷰에서 확인한 문제를 결합한 synthetic composite로 명시한다.

1. 오늘 방문과 signed note를 감지한다.
2. Agent가 claim draft를 만들고 coverage, code, modifier를 preflight한다.
3. 사용자가 일회성 승인을 하면 claim submission receipt를 만든다.
4. Clearinghouse와 payer acceptance를 표시한다.
5. PMS에는 processing이지만 최신 synthetic payer observation은 authorization denial이다.
6. Agent가 기존 authorization evidence와 denial의 충돌을 설명한다.
7. Agent가 payer reprocessing message를 작성한다.
8. 사용자가 거절하면 아무 상태도 바뀌지 않는다. 승인하면 receipt, artifact, next follow-up, audit event가 생긴다.
9. Reprocessing을 paid로 과장하지 않고 후속 상태를 계속 추적한다.
10. Remittance와 posting evidence가 모두 있는 별도 fixture만 verified paid로 표시한다.

## 사실과 데모의 경계

- 실제 Stedi test workflow로 837P submission, 277CA, paid-only 835를 시연할 수 있다.
- Stedi test 835는 현실적인 denial 또는 appeal을 만들지 않으므로 해당 구간은 synthetic이다.
- 현재 Medplum Stedi claim-response integration은 inbound 277/835를 raw `DocumentReference`로 저장하며 자동으로 adjudication `ClaimResponse` 또는 `PaymentReconciliation`을 만들지 않는다.
- Payer portal 상태 조회와 phone workflow는 Medplum 또는 Stedi 기본 기능이 아니다. 초기 데모는 synthetic payer connector를 사용한다.
- Bank settlement 확인은 이번 범위에 없다. UI 문구는 `Remittance received`, `Posted`, `Reconciled`를 사용한다.

## 개인정보와 시각 자료 제한

- 원본 interview keyframe과 transcript에는 식별 가능 정보가 포함될 수 있다.
- 원본 이미지를 코드, public demo, prompt packet, test fixture에 복사하지 않는다.
- 화면 구조와 workflow pattern만 추출한다.
- 모든 데모 데이터는 synthetic이며 실제 인물, member ID, claim ID, payer reference를 재사용하지 않는다.
