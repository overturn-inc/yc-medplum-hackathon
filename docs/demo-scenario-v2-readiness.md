# Hackathon demo scenario v2 and readiness audit

Status: product direction recorded, implementation gaps audited

Audited: 2026-08-01

Public demo: https://overturn-agentic-claims.argentum1450.chatgpt.site

## 결론

현재 공개 제품은 PMS dashboard, visit-to-claim approval, claim follow-up,
clearinghouse rejection correction, payer denial reprocessing, supporting
document send, verified-paid 검증까지 안정적으로 동작한다.

하지만 새 hero scenario의 핵심인 실제 전화 흐름, 공개 보험사 portal에서의
browser automation, formal appeal 작성과 제출은 아직 제품에 없다. Public Stedi는
설정되지 않았고 public healthcare mode는 local synthetic FHIR이므로 live Medplum도
아니다. 따라서 현재 상태를 새 시나리오의 완성본으로 표현하면 안 된다.

## Demo narrative source of truth

### Problem

보험사는 자동화와 규모의 이점을 갖지만 solo practice와 independent practice는
claim follow-up, rejection, denial, payer portal, 전화, appeal을 사람이 직접 처리한다.
이 행정 부담은 clinician과 staff의 시간을 빼앗고 작은 practice가 환자 진료에
집중하기 어렵게 만든다.

Pitch에서 `보험사의 AI가 denial rate를 높인다`는 인과 주장은 별도 근거를 붙이기
전까지 단정하지 않는다. 데모가 직접 입증하는 문제는 여러 source의 상태 불일치와
수동 follow-up burden이다.

### Solution

Overturn은 solo practice를 위한 medical billing agent다. 방문이 완료된 뒤 claim을
준비하고, clearinghouse와 payer 상태를 계속 추적하고, rejection과 denial을 해결하고,
필요할 때 appeal까지 제출한다. 외부 write는 정확한 payload에 대한 `Allow once`
승인 후에만 실행한다.

### Product line

> Overturn — the medical billing agent for solo practices.

## Sponsor technology roles

| Technology | 데모에서 맡길 필수 역할 | 현재 상태 |
|---|---|---|
| Medplum | FHIR R4 기반 Encounter, Claim, ClaimResponse, Coverage, Task, DocumentReference, Provenance, AuditEvent의 data and audit plane | Adapter와 typed FHIR model은 있음. Public은 `Healthcare: local`; live Medplum credential 없음 |
| Stedi | Claim 전 270/271 eligibility 확인과 clearinghouse boundary | Local live eligibility proof 있음. Public UI는 `Stedi not configured`. 현재 Sandbox는 837P claim API를 허용하지 않으므로 claim rail은 synthetic이라고 표시해야 함 |
| Moss | Claim별 denial, authorization, 277, portal evidence 검색과 agent grounding | Public에서 live. AWS sidecar와 synthetic-only index를 사용하고 claim scope filter가 동작함 |
| Deepgram | Portal로 해결되지 않는 payer 전화의 speech recognition, voice response, transcript 생성 | 과거 전화 proof 설명만 문서에 있고 현재 repo와 public workflow에 재현 가능한 구현이 없음 |
| Breakfast Factory | Agent reasoning, intent classification, tool orchestration, approval 전 proposal 생성 | Public에서 live BFF 사용 중 |

Medplum은 intro에서 logo로만 언급하지 않는다. `visit이 FHIR Encounter로 들어오고,
agent가 만든 Claim, evidence, Task, Provenance가 같은 patient episode graph에 남는다`는
방식으로 시작과 끝에 보여준다.

Moss는 denial 화면에서 별도 검색 demo로만 보여주지 않는다. Portal denial과 전화
transcript가 들어온 뒤 authorization evidence를 찾아 `correct, reprocess, appeal` 중
다음 action을 결정하는 근거 retrieval로 보여준다.

## Target hero flow

여러 case를 나열하는 현재 dashboard는 유지하되, 발표의 주 흐름은 하나의 synthetic
patient와 claim이 시간에 따라 변하는 이야기로 만든다.

1. Medplum synthetic Encounter가 완료되고 signed note가 도착한다.
2. Agent가 coverage, code, provider, charge를 점검한다.
3. Stedi 270/271 test eligibility를 실행해 active coverage를 확인한다.
4. Agent가 claim proposal을 만들고 사람이 `Allow once`를 승인한다.
5. 현재 계정 한계 때문에 claim transport는 `Simulated Stedi clearinghouse rail`로
   명확히 표시한다. Submitted는 paid가 아니다.
6. Time jump 후 clearinghouse에는 accepted, PMS에는 processing이지만 remittance가
   없는 follow-up exception이 생긴다.
7. Agent가 synthetic payer portal을 열고 member, claim, DOS를 입력해 denial 또는
   pending status를 찾는다. 화면에는 browser action, input, result, screenshot과
   receipt가 순서대로 나타난다.
8. Portal 결과가 불충분하면 Twilio와 Deepgram을 통해 synthetic payer call을 하고
   live transcript와 extracted facts를 claim evidence에 붙인다.
9. Moss가 denial, authorization, 277, portal snapshot, call transcript를 claim scope로
   검색한다.
10. Agent는 먼저 correction 또는 reprocessing 가능성을 판단한다. 인터뷰상 appeal은
    corrected claim과 payer follow-up 이후의 예외 branch다.
11. Formal appeal이 필요한 branch에서는 payer portal에서 appeal form을 받아 synthetic
    data로 채우고 evidence packet과 submission preview를 만든다.
12. 사람이 `Allow once`를 누르면 dummy portal에 appeal을 제출하고 confirmation number,
    next follow-up, FHIR Provenance와 AuditEvent를 남긴다.
13. Dashboard와 claim timeline이 새 상태를 즉시 반영한다.

## Readiness matrix

| Flow | Readiness | Audit result |
|---|---|---|
| PMS dashboard and work queues | Ready | Public dashboard에 7개 synthetic episode, KPI, approvals, exceptions, funnel이 표시됨 |
| Visit detected and claim preflight | Partial | Encounter A와 모든 preflight check는 있음. 새 visit 감지와 agent reasoning이 진행되는 activity animation은 없음 |
| Claim approval and submission receipt | Ready, synthetic | `Allow once` 후 Claim과 synthetic receipt가 생기고 clearinghouse-received로 이동함 |
| Live Stedi eligibility | Partial | Local proof와 endpoint는 있음. Public 배포에서는 disabled |
| Live Stedi 837P claim submission | Blocked by account | Sandbox claim endpoint 403. 제품은 synthetic rail로만 표현 가능 |
| Follow-through and source discrepancy | Ready | Accepted-but-overdue refresh, PMS processing versus payer denied, next follow-up이 동작함 |
| Payer phone call with Deepgram | Missing from product | Repo code, public UI, transcript persistence, audit receipt가 없음 |
| Denial and rejection resolution | Ready, synthetic | Payer denial reprocessing과 clearinghouse member mismatch correction이 구분되어 동작함 |
| Public dummy payer portal | Missing | Portal route와 synthetic lookup/form backend가 없음 |
| Visible browser or computer use | Missing | Portal navigation, typed inputs, screenshot stream, tool receipt가 없음 |
| Appeal packet and submission | Missing | Domain enum만 있고 proposal builder, action policy, executor, fixture, UI, tests가 없음 |
| Live Moss retrieval | Ready | Public Claim C에서 AWS local sidecar, four claim-scoped matches, score와 latency가 표시됨 |
| Live Medplum | Partial | FHIR model과 mock-tested adapter는 있음. Public data source는 local |
| Live BFF agent | Ready but slow | Public BFF와 grounded answer는 동작함. 이번 수동 audit의 Moss 질문은 응답까지 약 45초가 걸림 |
| End-to-end public regression | Ready for current scope | Public synthetic mutation E2E가 2026-08-01 재실행되어 통과함 |

## Evidence from the current audit

- Public dashboard badges: `Synthetic data`, `Healthcare: local`, `Agent: bff`,
  `No live payer writes`.
- Encounter A: all seven preflight checks, proposal, Deny, Allow once, synthetic
  submission receipt.
- Claim B: approval-free read-only payer refresh and follow-up scheduling.
- Claim C: PMS processing versus payer denial, live Moss retrieval, reprocessing
  proposal, one-time approval and receipt.
- Claim D: clearinghouse rejection, member ID diff, corrected resubmission.
- Claim E: signed supporting note send after approval.
- Claim F: verified paid only when remittance and independent PMS posting agree.
- The public full mutation E2E passed from Encounter A through Claim F, persistence,
  session isolation and reset.

## Next implementation order

1. Build a fictional public payer portal with synthetic member lookup, claim status,
   denial detail, reprocessing and appeal form endpoints. Do not copy a real payer's
   logo, name, credentials flow, or protected visual identity.
2. Add an AWS-hosted browser worker controlled by BFF. Stream action events and
   screenshots into the Overturn claim timeline so browser use is visibly real.
3. Add a reproducible Twilio and Deepgram service to this repo, limited to a synthetic
   payer call, and persist transcript plus extracted facts as evidence.
4. Add an appeal fixture and full approval-gated action path: proposal, packet,
   portal form fill, submit receipt, follow-up, Provenance, AuditEvent and tests.
5. Enable public Stedi synthetic eligibility with server-side secret, rate limiting
   and a fixed approved Jane Doe request. Continue labeling the claim rail simulated.
6. Connect a synthetic Medplum project or provide a visible FHIR write-through proof.
7. Reduce agent response latency and add immediate staged progress so a judge never
   sees a frozen button.
8. Replace the disconnected multi-case presentation with one guided hero claim while
   keeping the dashboard cases available as supporting proof.

## Demo-complete acceptance criteria

- A judge can run the whole hero flow without a presenter repairing state.
- Every stage changes the dashboard, claim lifecycle, evidence and activity timeline.
- Portal and phone actions show live progress within one second even if completion is
  asynchronous.
- The phone transcript, portal result and Moss matches are tied to the same claim only.
- Rejection, denial, correction, reprocessing and appeal remain distinct states.
- No external write occurs without one-time approval.
- Every synthetic or simulated boundary is visible in the UI.
- Refresh and reset are deterministic.
- Unit, contract, replay, database, FHIR, browser E2E, public E2E, build and secret
  audit all pass.
