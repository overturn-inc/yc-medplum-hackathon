# Design Brief

> 이 문서는 초기 논의 기록이다. 확정된 범위는 [product-spec.md](product-spec.md)와 [implementation-plan.md](implementation-plan.md)를 따른다.

## 권장 제품 문장

**환자 방문에서 claim 제출, payer 상태 확인, source discrepancy 해결, remittance posting까지 이어지는 AI-native practice management workspace.**

## 권장 5분 데모

1. Practice dashboard에서 오늘 방문, ready claim, follow-up, discrepancy를 본다.
2. 완료된 encounter의 claim preflight를 검토하고 synthetic submission을 승인한다.
3. PMS processing과 payer authorization denial의 source discrepancy를 확인한다.
4. Agent가 authorization evidence를 찾아 reprocessing message를 제안한다.
5. 사용자의 일회성 승인 후에만 artifact, receipt, follow-up을 생성한다.
6. Remittance와 posting이 모두 있는 claim만 verified paid임을 보여준다.
7. 모든 evidence, 판단, 승인, 실행을 claim episode에 남긴다.

## 잠정 책임 분리

| 레이어 | 맡을 일 | 맡지 않을 일 |
|---|---|---|
| Medplum | FHIR resource, search, event, workflow state, provenance | 범용 agent runtime |
| BFF | agent thread/run, model execution, durable event stream | healthcare source of truth |
| Overturn agent | 사용자 대화, plan, approval, artifact review | payer 또는 Medplum credential 직접 노출 |
| Hackathon product | claim-specific UI, demo orchestration, judge-facing story | production RCM 전체 |

## 확정된 결정

1. 주 사용자는 biller 또는 practice operations staff다.
2. 핵심 순간은 source discrepancy 탐지와 authorization denial reprocessing이다.
3. Medplum은 FHIR resource, Task, raw evidence, Provenance와 audit의 source of truth다.
4. Agent는 read, compare, explain, draft를 자동화하고 external write는 일회성 승인을 받는다.
5. 5분 안에 KPI 변화, source evidence, generated artifact, execution receipt, next follow-up으로 결과를 증명한다.
