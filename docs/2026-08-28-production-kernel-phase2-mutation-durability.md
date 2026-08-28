# Production Kernel Phase 2 검증 영수증

- 검증일: 2026-08-28
- 범위: mutation correlation, Chapter commit receipt, compound HIL, reference activation recovery
- 상태: 구현·회귀·P0/P1 감리 완료
- 선행 기준선: `06e08d07` (`master`)

## 구현 결과

Phase 2의 기존 mutation 내구성만 보강했다. ProductionCommand/Run projection,
Soul/Skill binding, FTS 또는 graph runtime은 아직 도입하지 않았다.

### Production attempt와 Chapter commit

- 모든 Chapter mutation은 Book lock 안에서 host 소유 UUID
  `productionOperationId`와 `attemptId`를 한 번 만든다.
- 각 fiction operation과 invocation trace/receipt/outcome/tool authorization은 해당
  attempt를 상속한다. production ID와 fiction operation ID는 분리한다.
- write, audit, revise, state repair, resync, import가
  `chapter-commit-receipt/v1`을 Chapter journal 안에서 기록한다.
- receipt는 exact manuscript/index/current-state hash, fiction operation manifest,
  Rail truth applicability와 commit state를 연결한다. capability와 실제 fiction
  operation kind가 다르면 fail-closed한다.
- Rail truth evidence가 빠지면 원고를 재생성하지 않고
  `production-evidence-needs-recovery`로 차단한다. `write repair-evidence`는 원고
  hash를 재검증한 뒤 evidence와 index gate만 복구한다.

### Typed compound HIL

- Studio, CLI와 Storyyard approve가 동일한
  `PipelineRunner.applyReferenceHilCandidate()`를 사용한다.
- decision receipt 검증, 후보 원고 적용, truth resync, creative audit와 terminal
  판정을 하나의 Book lock 및 production attempt로 묶었다.
- 승인된 원고는 forward-only다. resync/audit 실패 시 되돌리지 않고 append-only
  `needs-attention` transition을 남긴다.
- process death 뒤 applied candidate와 transition history를 읽어 같은 attempt로
  재개한다. decision/candidate/transition correlation과 sequence가 다르면
  fail-closed한다.
- `ready` 재진입도 verified audit commit receipt와 현재 Chapter gate를 다시
  검증한다. receipt가 유실·손상되면 `needs-attention`으로 내려 UI false-ready를
  막는다.
- Studio HIL 목록은 후속 처리 건수와 현재 apply transition을 표시한다.

### Reference install과 recovery

- reference pack, story index, style examples와 raw source bytes를 SHA-256 기반
  content-addressed object로 project `.inkos/reference-packs/objects/`에
  `temp -> fsync -> rename -> directory fsync`로 설치한다.
- Book-local binding, Book config, transformation map과 Rail activation은 durable
  Book mutation journal로 감싼다. activation 실패나 process death 시 이전 Book
  bytes를 복구하고, 이미 설치된 미참조 object는 무해하게 남긴다.
- 기존 binding은 계속 읽을 수 있으며 supporting reference는 소비 계약이 생길
  때까지 `planned` 상태로 유지한다.

## 감리 결과

- 최종 P0: 없음
- 최종 P1: 없음
- 감리 중 수정: compound attempt 안의 receipt filename 충돌을 production/fiction
  복합 key로 제거했다.
- 감리 중 수정: 기존 `ready` transition 재진입이 audit receipt 없이 완료를
  반환할 수 있던 false-ready 경로를 차단했다.
- 감리 중 수정: reference bind의 Book read를 lock 안으로 옮기고 receipt
  capability와 fiction operation kind 일치를 강제했다.
- upstream 호환을 위해 mass rename 없이 새 contract, adapter와 journal module로
  구현했다.

## 검증

- Core: 217 files, 2,441 tests PASS
- Studio: 61 files, 651 tests PASS
- CLI: 46 files, 251 tests PASS
- 합계: 3,343 tests PASS
- 실제 child process `SIGKILL` fault injection: Chapter rollback, reference
  activation rollback, applied HIL resume 3건 PASS
- `pnpm -r typecheck`: PASS
- `pnpm build`: PASS
- `pnpm audit:semantic-patterns`: PASS, 기존 후보 26건 보고
- `pnpm verify:publish-manifests`: PASS
- `git diff --check`: PASS

## 경계와 다음 재개점

Phase 3 이후는 미착수다. 다음 단계는 observe-only Production Kernel과 run
projection이다. 기존 canon bytes와 모델 호출 수가 기준선을 벗어나면 enforce로
승격하지 않는다.
