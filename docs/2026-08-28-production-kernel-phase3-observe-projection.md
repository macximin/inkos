# Production Kernel Phase 3 — observe projection 구현 영수증

- 일자: 2026-08-28
- 상태: 구현·회귀·P0/P1 감리 완료
- 범위: `write-next-chapter` 단일 adapter와 observe-only run projection
- 기본값: `production.kernel=off`
- 미착수: production Skill, BookSoulBinding, HQ v2, FTS5, Pi worker 전환

## 결론

기존 `PipelineRunner`와 Chapter journal을 유일한 canon mutation 경로로 유지한
채로, 그 바깥에 typed authority와 재생 가능한 실행 projection을 붙였다. 새
커널은 모델 호출이나 창작 단계를 추가하지 않으며 graph runtime, 두 번째
transaction layer 또는 두 번째 canon state machine을 만들지 않는다.

설계 감리를 두 번 반복한 뒤에도 다음 결론은 바뀌지 않았다.

1. Book lock과 Phase 2 Chapter commit receipt가 실행·복구의 정본이다.
2. Phase 3은 기존 실행을 감싸는 observe projection이어야 한다.
3. abandoned run은 receipt와 canon fingerprint로만 reconcile하며 Writer를 다시
   부르지 않는다.
4. free text는 제안 입력이고 button, slash, quick-action의 typed `write_next`만
   mutation authority가 된다.

## 구현

### 명령과 실행 상관관계

- strict self-hashed `production-command/v1`
- Book, session, request, optional work order와 optional Soul binding
- detached owner-direction text SHA와 lease receipt 재검증
- stable intent digest와 idempotency key 충돌 차단
- `AsyncLocalStorage` 기반 `ProductionExecutionContext`
- context는 correlation만 제공하며 권한·Book binding·commit evidence 검증을
  우회하지 않음

Phase 4 receipt가 아직 없으므로 `activatedSkills`는 빈 배열만 허용한다. Studio의
requested Skill ID를 실제 활성화 증거로 기록하지 않는다.

### 실행과 projection

- `production.kernel=off|observe|enforce`
- `off`: 기존 경로 유지
- `observe`: 단일 typed write-next만 새 adapter 사용
- `enforce`: promotion gate 전까지 명시적으로 fail-closed
- preparing/running snapshot의 atomic write·readback
- Book lock 안에서 owner decision lease를 Writer 호출 직전에 재검증
- 동일 command 또는 동일 intent의 retry는 terminal을 재사용하고 모델을 재호출하지
  않음
- 같은 idempotency key와 다른 intent는 실행 전 거절

`production-run/v1` terminal은 Chapter receipt 본문을 복제하지 않는다. receipt
파일의 Book-local path·SHA, receipt ID와 commit state, 필수 artifact reference만
남긴다. terminal은 verified projection만 atomic snapshot-to-terminal 전환으로
설치하며 기존 terminal을 덮어쓰지 않는다.

### 실패와 process death

- 실패·취소는 Chapter journal이 보호하는 canon surface의 전후 fingerprint가
  완전히 같을 때만 verified no-commit terminal을 생성
- commit receipt가 있으면 호출 이후 오류도 succeeded/reconciled로 판정하고 canon을
  다시 쓰지 않음
- abandoned snapshot + receipt는 success로 reconcile
- abandoned snapshot + 동일 baseline은 failed/no-commit으로 reconcile
- receipt가 둘 이상이거나 canon fingerprint가 달라지면 fail-closed
- projection ancestor symlink는 쓰기 전에 거절

실제 child process를 receipt commit 직후 `SIGKILL`한 fixture에서 stale Book lock을
회수하고 terminal을 reconcile했으며 Writer 호출은 0회였다.

## Studio 경계

- free-text 명령문에 forged `requestedIntent=write_next`를 붙여도 chat/proposal
  경로에 남음
- typed quick-action의 단일 write-next만 observe adapter로 이동
- 다회차 요청과 `kernel=off`는 기존 호환 경로 유지
- Studio 결과에는 production run/operation ID, completion health와 projection
  origin을 표시

## 검증

- Core: 219 files, 2,452 tests PASS
- Studio: 61 files, 652 tests PASS
- CLI: 46 files, 251 tests PASS
- 합계: 3,355 tests PASS
- 실제 process-death fixture: PASS
- typecheck, build, semantic-pattern audit, publish manifest, diff check: PASS

## 최종 P0/P1 감리

감리 중 P1 두 건을 구현 완료 전에 수정했다.

1. terminal에 Chapter receipt 전체를 복제하던 초안을 path·SHA·minimal state
   reference로 축소했다.
2. Phase 4 이전 requested Skill ID가 `activatedSkills`로 보일 수 있던 경로를
   fail-closed로 바꿨다.

보정 후 회귀와 정적 감리에서 잔여 P0/P1은 없다. `enforce` 승격, 실제 Soul/Skill
binding과 다중 surface 수렴은 각각 Phase 4·5 완료선을 통과하기 전까지 주장하지
않는다.
