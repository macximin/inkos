# Production Kernel Phase 6 — neutral runtime canary 영수증

- 일자: 2026-08-28
- 상태: canary 구현·2회 연속 실행·P0/P1 감리 완료
- 범위: legacy baseline → kernel observe → kernel enforce, CLI-direct·Agent·HQ
  surface ingress parity
- 고정 변수: Soul `null`, Pi worker `off`, retrieval `legacy`, FTS `off`,
  review mode `manual`
- 기본값 유지: `production.kernel=off`, `production.surfaceGateway=legacy`
- 미착수: genre Soul 결합·promotion, Pi/FTS 전환, lineage

## 결론

동일한 pre-generation Book snapshot과 deterministic Writer fixture에서 legacy,
observe, enforce 및 CLI-direct·Agent·HQ 다섯 lane을 비교했다. 다섯 lane 모두
canon 파일 3종의 bytes, 모델 호출 수 1회와 검토 투영
`ready-for-review/pending`이 일치했다. Kernel observe에서 enforce로 바꿔도 canon
호출은 늘지 않았고, Agent와 HQ source도 동일 command→attempt→commit receipt
상관관계를 통과했다.

이번 결과는 runtime 경로의 구조적 parity 증거다. 실제 장르 Soul의 상업 품질,
사람 HIL 승인, 실서비스 기본값 승격이나 provider별 문학적 결과 동등성을
주장하지 않는다.

## 실행 행렬

| lane | kernel | surface | command source | Soul | canon call | model call | HIL projection |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| legacy baseline | off | legacy | direct | null | 1 | 1 | ready-for-review / pending |
| observe direct | observe | kernel | cli | null | 1 | 1 | ready-for-review / pending |
| enforce direct | enforce | kernel | cli | null | 1 | 1 | ready-for-review / pending |
| enforce Agent | enforce | kernel | agent | null | 1 | 1 | ready-for-review / pending |
| enforce HQ | enforce | kernel | hq | null | 1 | 1 | ready-for-review / pending |

Machine-readable matrix는
`packages/core/src/__tests__/fixtures/production-kernel-phase6-neutral-canary.json`,
실행 canary는
`packages/core/src/__tests__/production-kernel-phase6-neutral-canary.test.ts`다.
`pnpm canary:phase6-neutral`로 한 파일만 독립 실행한다.

## 증명 범위

### Canon byte parity

각 lane은 별도 임시 project의 동일 Book ID와 빈 Chapter index,
`story/current_state.md`에서 시작한다. 실행 후 다음 세 파일을 raw `Buffer`로
비교한다.

- `chapters/0001_첫-인수전.md`
- `chapters/index.json`
- `story/current_state.md`

Chapter commit receipt와 production run은 lane별 UUID·source·mode를 가져야 하므로
canon byte 비교 대상이 아니라 상관관계 검증 대상이다.

### Model-call·HIL parity

- 모든 lane의 fiction-content evidence ledger에서 Writer invocation은 정확히
  1개다.
- Agent/stage/model/status는
  `writer / writer / phase6-deterministic-writer / completed`로 같다.
- Chapter result는 `ready-for-review`, audit passed, issue 0이다.
- Kernel run의 approval projection은 모두 `pending`이다. 이는 사람 승인 완료가
  아니라 같은 HIL 대기 상태가 보존됐다는 뜻이다.

### Ingress·receipt correlation

observe/enforce lane은 mock dispatcher가 아니라 실제
`PipelineRunner.executeSurfaceWriteNext`를 사용한다. source별 authorization은
각각 `confirmed-cli`, `confirmed-agent-tool`,
`authenticated-orchestrator`이며 모두 `production-command/v2`로 저장된다.

각 run에서 command binding, execution context와 production attempt의
`productionOperationId/attemptId`가 일치하고, Chapter result의 attempt와 verified
commit receipt ID가 terminal run evidence에 다시 결속되는지 검증한다. Phase 5의
Agent tool routing과 HQ actual-child bodyless evidence fixture는 이 canary보다 아래
adapter 경계를 별도로 계속 검증한다.

## 고정 변수와 해석

기존 Soul 계획의 `bindingKind=neutral-baseline` 정의대로 Soul ID/version/SHA와
analysis profile은 strict `null`이다. `neutral` lifecycle BookSoulBinding을 새로
만들어 prompt를 주입하는 lane이 아니다.

Pi worker와 FTS는 아직 구현·활성화되지 않았고 retrieval은 기존 legacy reader를
그대로 쓴다. canary matrix에 이를 명시해 Optional Track A/B와 Phase 6 결과를
섞지 않았다. 이 단계에서는 runtime flag 기본값도 바꾸지 않는다.

## 검증

- `pnpm canary:phase6-neutral`: 1 file, 2 tests PASS
- 같은 명령 2회 연속 PASS
- Core 전체: 223 files, 2,471 tests PASS
- Studio: 61 files, 654 tests PASS
- CLI: 46 files, 252 tests PASS
- 합계: 3,377 tests PASS
- typecheck, build, semantic-pattern audit, publish manifest, diff check: PASS
- HQ manifest/status와 30 tests PASS

## 최종 P0/P1 감리

1. 처음에는 source variant를 Core kernel에 바로 주입하는 test 구성을 검토했으나,
   이것만으로는 surface gateway를 증명하지 못한다. 최종 canary는 실제
   `PipelineRunner.executeSurfaceWriteNext`를 통과하도록 바꿨다.
2. `neutral binding`을 lifecycle `neutral` Soul package로 오해하면 baseline에 새
   prompt가 들어간다. 기존 Soul SSOT를 재확인해 strict Soul `null` baseline으로
   고정했다.
3. UUID가 다른 receipt 파일 전체를 canon parity로 비교하면 거짓 실패가 된다.
   작품 정본 bytes와 상관관계 receipt 검증을 분리했다.
4. `pending`을 사람 HIL 승인으로 오인하지 않도록 결과를 검토 대기 상태로만
   판정했다.

보정 뒤 현재 범위의 잔여 P0/P1은 없다. Phase 7은 이 runtime canary와 별개인
Soul source registry·manager deep-read·Review Packet 준비 상태부터 다시 감사한다.
