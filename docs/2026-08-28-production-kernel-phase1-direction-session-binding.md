# Production Kernel Phase 1 검증 영수증

- 검증일: 2026-08-28
- 범위: owner direction provenance, Writer task guidance, strict session binding
- 상태: 구현·회귀·P0/P1 감리 완료
- 선행 기준선: `6dad71c1` (`master`)

## 구현 결과

Phase 1의 두 정확성 결손만 수정했다. 새 Production Kernel, WorkOrder v2,
run projection, Soul/Skill binding, FTS 또는 graph runtime은 도입하지 않았다.

### Owner direction과 model guidance 분리

- confirmed Studio/Agent 지시의 exact UTF-8 bytes를
  `.inkos/private/detached-payload-leases/` 아래 ignored local-only lease로 저장한다.
- lease directory는 `0700`, payload와 receipt는 `0600`이며
  `temp -> fsync -> rename -> directory fsync` 순서로 기록한다.
- action payload와 production tool result의 owner-direction 필드에는 본문 대신
  lease ID, SHA-256, byte length, expiry, receipt SHA를 갖는 `owner-confirmed`
  reference만 남긴다. 기존 session transcript의 user message는 대화 정본으로
  그대로 보존한다.
- payload·receipt 유실, 만료, 변조, 길이 또는 hash 불일치는 Writer production
  provider 호출 전에 fail-closed한다. Agent 경로의 대화 모델은 owner의 현재
  user message를 이미 입력으로 받지만, 유효한 lease 없이는 Writer를 실행하지
  못한다.
- `sub_agent(writer).instruction`은 transcript request/tool call을 가리키는
  `model-mediated` guidance로 별도 전달한다. 단일·batch Writer 모두 exact bytes와
  SHA를 받지만 owner direction, BookRule 또는 canon 권위를 얻지 않는다.
- Writer prompt는 owner instruction을 highest-priority block에, model guidance를
  subordinate block에 각각 배치한다. owner bytes는 trim하거나 재작성하지 않는다.

### Strict session binding

- strict transcript reader는 JSONL 파일 순서, schema, session ID, strictly
  increasing sequence와 정확히 하나인 leading `session_created`를 검증한다.
- 전체 `session_metadata_updated` chain에서 effective binding을 계산한다.
- 허용 전이는 unbound `null -> Book` 한 번뿐이며 이때 `sessionKind=book`을 함께
  고정한다. Book-to-Book, Book-to-null, session kind drift는 거절한다.
- binding 검증은 Agent cache restore, Skill/model resolution과 모델 호출보다 먼저
  실행된다.
- transcript append와 null-to-Book migration은 동일 per-session queue에서
  직렬화된다. concurrent migration에서는 정확히 한 Book만 승리한다.
- Studio는 Core의 `SessionBindingMismatchError`를 HTTP 409
  `SESSION_BINDING_MISMATCH`로 투영하며 Core가 실제 불변식을 소유한다.

## 감리 결과

- P0: 없음
- P1: 없음
- 보강 사항: Studio 409 projection 회귀 테스트를 추가했다.
- private payload 본문은 Git status에 나타나지 않았고 새 tracked fixture에도
  복제되지 않았다.
- Phase 0에서 고정한 upstream 비채택·현재 fork 보존 계약은 유지됐다.

## 검증

- Core: 215 files, 2,433 tests PASS
- Studio: 61 files, 651 tests PASS
- CLI: 46 files, 251 tests PASS
- 합계: 3,335 tests PASS
- `pnpm typecheck`: PASS
- `pnpm build`: PASS
- `pnpm audit:semantic-patterns`: PASS, 기존 후보 26건 보고
- `pnpm verify:publish-manifests`: PASS
- `git diff --check`: PASS

## 경계와 다음 재개점

Phase 2 이후는 미착수다. 다음 구현 세션은 기존 mutation 내구성 보강만 다룬다.
구체적으로 `ProductionAttemptIdentity`, fiction-operation correlation,
typed `hil-apply`, universal chapter commit receipt, reference-bind journal과 fault
injection을 완료선으로 삼는다. HQ WorkOrder v2 parity는 계획대로 Phase 5까지
보류한다.
