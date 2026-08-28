# Production Kernel Phase 5 — HQ v2·실행 표면 수렴 구현 영수증

- 일자: 2026-08-28
- 상태: 구현·회귀·P0/P1 감리 완료
- 범위: `write-next-chapter` WorkOrder/RunReceipt v2, Core surface gateway,
  effective runtime·model-call evidence readback
- 기본값: `production.kernel=off`, `production.surfaceGateway=legacy`
- 미착수: dual/enforce canary, Soul promotion, FTS, Pi worker, lineage

## 결론

InkOS의 Studio, CLI, TUI, Agent tool과 HQ `write-next`가 같은
`ProductionCommand v2` gateway를 사용하도록 수렴했다. 실행 권한과 현재
Book/session/Soul 결속은 Core가 판정하고, 실제 집필·commit은 기존
`PipelineRunner`만 수행한다. HQ는 exact stdin command와 그 SHA를 전달하고
검증된 evidence 경로·SHA만 집계한다. 원고나 receipt 본문을 소유하지 않는다.

기존 `production-command/v1`, WorkOrder v1과 RunReceipt v1은 계속 동작한다.
`surfaceGateway=legacy`가 기본이므로 이번 구현만으로 기존 production 경로가
자동 승격되지 않는다.

## 구현

### Strict v2 계약과 권한

- `ProductionCommand v2`는 action source마다 다음 authorization variant를
  강제한다: `confirmed-ui`, `confirmed-cli`, `confirmed-agent-tool`,
  `authenticated-orchestrator`.
- HQ `work-order/v2`는 self-hashed exact command, owner decision,
  idempotency와 `expectedSoulBinding`을 묶는다. `null`도 "현재 active Soul 없음"이라는
  명시적 기대로 취급한다.
- HQ는 command JSON의 정확한 UTF-8 bytes를 stdin으로 보내며 argv에 owner
  direction을 노출하지 않는다.
- `run-receipt/v2`는 bodyless다. child production run, artifact, model-call receipt와
  outcome의 repo-relative path·SHA와 식별자만 담는다.
- v2 Book ID는 filesystem 접근 전에 검증하고 path escape와 symlink evidence를
  fail-closed한다.

### 실행 표면 수렴

- Studio confirmed action, CLI confirmation, TUI quick action, Agent confirmed tool,
  HQ authenticated order가 동일 Core gateway로 들어간다.
- gateway가 활성화된 상태의 direct `writeNextChapter`와 batch write는 우회를
  막기 위해 거절한다.
- 같은 idempotency와 동일 intent는 기존 terminal을 재사용한다. command args,
  authorization, Book/session/Soul binding이 달라지면 모델 호출 전에 거절한다.
- `dual`은 v1/v2 호환 receipt와 projection을 함께 읽고 쓰는 기간을 뜻하며,
  canon 집필을 두 번 호출하지 않는다.

### Owner direction과 model-mediated guidance

- owner direction은 기존 detached lease의 exact bytes와 hash를 유지한다.
- 모델이 Agent transcript에서 만든 task guidance는 별도
  `model-mediated` 입력으로 분리한다.
- resolver는 persisted transcript의 정확히 한 tool call, tool-call identity,
  guidance bytes와 SHA를 다시 검증한다. 자유 대화나 요약문을 owner 지시로
  승격하지 않는다.

### Effective runtime readback

- 실행 시 실제 Writer agent의 effective model과 reasoning을 readback한다.
- model call receipt/outcome의 실제 파일 bytes, SHA, attempt/request/session,
  model, reasoning, stage와 status 상관관계를 검증한다.
- production run과 모든 evidence path는 대상 Book 안의 regular non-symlink
  file이어야 한다.
- HQ는 검증 실패를 `needs-attention`으로 남기며 성공 receipt를 만들지 않는다.

## 호환 범위와 의도적 제한

- Phase 5의 typed mutation 범위는 `write-next`, `chapterCount=1`이다.
- v2의 approved/private input 배열은 command binding을 구현하기 전까지 비어
  있어야 한다. non-empty 입력을 조용히 무시하지 않고 schema에서 거절한다.
- 범용 `propose_action`은 이번 typed `write-next` confirmation 범위 밖이다.
- durable pending proposal UI는 새 SSOT로 만들지 않았다. 실행 직전 typed action을
  다시 command로 만들고 current args·Soul binding·self-hash를 검증한다.
- neutral `observe → enforce` 승격과 실제 HQ canary는 Phase 6에서 별도로 수행한다.

## 검증

- Core: 222 files, 2,469 tests PASS
- Studio: 61 files, 654 tests PASS
- CLI: 46 files, 252 tests PASS
- 합계: 3,375 tests PASS
- HQ: 30 tests PASS, WorkOrder/RunReceipt v2 JSON Schema parse PASS
- InkOS typecheck, build, semantic-pattern audit, publish manifest, diff check: PASS
- HQ v2 actual child fixture: bodyless receipt 저장, tampered evidence
  `needs-attention`, exact `--work-order-sha` 1회 전달 PASS

## 최종 P0/P1 감리

감리 중 다음 정확성 결손을 구현 완료 전에 수정했다.

1. HQ가 child가 보고한 evidence SHA를 신뢰하고 실제 파일 bytes를 다시 읽지 않는
   경로가 있었다. production run, artifact와 model-call evidence를 모두 실제
   regular file로 재검증하고 Book 밖 path와 symlink를 차단했다.
2. unsafe Book ID가 일부 entrypoint에서 filesystem 접근 뒤에 거절될 수 있었다.
   Core, CLI와 HQ v2에서 접근 전 공통 검증하도록 고쳤다.
3. runtime receipt가 global config model을 보고해 Book별 Writer override와 달라질
   수 있었다. 실제 Writer agent context의 effective model·reasoning을 사용한다.
4. 아직 command-bound하지 않은 v2 private/approved inputs가 허용되면 검증된
   것처럼 보일 수 있었다. 현재 지원 범위를 빈 배열로 fail-closed했다.
5. HQ readback의 신규 artifact path가 Windows에서 native separator를 낼 수
   있었다. 기존 `toPosixPath` helper로 모든 persisted path를 정규화했다.
6. 최초 실행 전 대기 중인 HQ 승인에는 expected Soul이 명시적으로 결속되지 않아
   승인 뒤 rebind를 놓칠 수 있었다. WorkOrder·owner args hash에 nullable
   `expectedSoulBinding`을 필수화하고 Core 실행 직전 active binding과 비교한다.

보정 후 전체 회귀와 정적 감리에서 잔여 P0/P1은 없다. 다음 재개점은 Phase 6의
neutral runtime canary이며, 현재 기본값은 계속 off/legacy다.
