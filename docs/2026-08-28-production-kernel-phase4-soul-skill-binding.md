# Production Kernel Phase 4 — Soul·Skill binding 구현 영수증

- 일자: 2026-08-28
- 상태: 구현·회귀·P0/P1 감리 완료
- 범위: `write-next-chapter` production Skill resolution, BookSoulBinding,
  session/runtime input receipt
- 기본값: `production.kernel=off`
- 미착수: HQ v2와 전체 ingress 수렴, enforce 승격, neutral/Soul canary,
  FTS, Pi worker, lineage

## 결론

InkOS가 생산 실행 주체라는 기존 경계를 유지하면서 Soul과 production Skill을
실제 Writer 요청에 넣고, 그 입력을 Book·session·command·operation receipt에
hash로 결속했다. 일반 Agent Skill의 last-write-wins registry는 바꾸지 않았고,
생산 경로에만 capability 소유의 별도 fail-closed resolver를 추가했다.

설계 감리를 두 번 반복한 뒤에도 다음 결론은 바뀌지 않았다.

1. Soul은 새 agent instance나 별도 repo가 아니라 Book에 결속되는 versioned
   creative input package다.
2. Skill은 workflow guidance이고 Soul은 장르·문체·상업적 판단을 위한 creative
   guidance다. 둘 다 Book canon, 수위 결정, HIL 승인 권한을 갖지 않는다.
3. 실제 원문 예문과 owner-authorized source slice는 Writer에 그대로 전달할 수
   있어야 하며, 겹침은 자동 감점·거리두기·재작성 사유가 아니다.
4. 결속 변경은 기존 session을 조용히 바꾸지 않고 새 Book session을 요구한다.
5. corpus 학습 완료와 Soul 상업 품질 promotion은 runtime plumbing 완료와
   분리한다.

## 구현

### Production Skill namespace

- `write-next-chapter`의 required Skill은 trusted builtin
  `inkos-long-writing`으로 고정했다.
- manifest와 필수 resource는 capability-owned SHA-256 pin으로 검증한다.
- owner overlay는 별도 namespace에서 명시적으로 요청된 ID만 해석한다.
- required Skill shadow, missing/disabled required Skill, 같은 ID의 서로 다른
  package, 로드 중 ID drift를 실행 전에 거절한다.
- package root/resource symlink, 허용되지 않은 확장자, NUL·비 UTF-8 text,
  512 KiB 초과 파일과 2 MiB 초과 package를 거절한다.
- receipt에는 실제 manifest/resource/input hash와 size만 남기고 prompt 본문은
  production run projection에 복제하지 않는다.

일반 Agent Skill registry의 기존 last-write-wins 동작은 호환성을 위해 유지된다.
production resolver만 더 엄격한 별도 정책을 사용한다.

### BookSoulBinding

- package schema: `soul-package/v1`
- owner decision schema: `soul-binding-decision/v1`
- content-addressed install:
  `.inkos/production/souls/objects/<object-sha256>`
- append-only Book history:
  `story/soul-bindings/vNNNN.json`
- active pointer: `story/soul-bindings/current.json`
- owner decision evidence:
  `story/soul-bindings/decisions/<decision-id>.json`
- lifecycle: `neutral|candidate|promoted`

결속은 기존 Book lock, mutation journal과 atomic file set 안에서 history, active
pointer, decision receipt를 함께 commit한다. 각 history entry는 self hash,
이전 binding hash, owner decision hash와 의미 필드를 검증한다. active pointer는
반드시 append-only history tip을 가리켜야 한다. rebind와 rollback도 과거 파일을
고치지 않고 새 version을 append한다.

Soul object는 pointer 활성화 전에 설치 후 전 byte를 다시 읽어 hash와 size를
검증한다. package path escape, symlink, NUL·비 UTF-8, 허용되지 않은 확장자,
파일·package 크기 초과를 fail-closed한다. 같은 Book에서 owner decision ID는
단 한 번만 쓸 수 있어 과거 decision receipt가 덮이지 않는다.

빈 candidate Soul은 runtime plumbing 검증에만 허용된다. 이것은 corpus 학습,
장르 품질 또는 상업적 promotion 증거가 아니다.

### Session과 runtime 결속

- Book session/transcript에
  `{soulId,soulVersion,bindingSha256}`를 고정한다.
- 새 Book session은 active Soul을 자동 해석한다.
- active binding이 달라진 기존 session은 모델 호출 전에 HTTP 409로 거절하며
  새 session을 요구한다.
- transcript에서는 기존 project session의 명시적 null-to-Book migration 한
  번을 제외하고 Soul binding drift를 허용하지 않는다.
- ProductionCommand의 requested/disabled Skill ID와 session Soul binding을 intent
  digest에 포함한다.

Kernel은 Book lock 안에서 active Soul과 required/requested Skill의 실제 bytes를
다시 해석하고 `production-input-receipt/v1`을 만든다. operation-scoped
`AsyncLocalStorage`에는 현재 실행 동안만 raw prompt와 owner direction을 두며,
fiction provider 요청에는 Soul/Skill block을 정확히 한 번 추가한다. Writer
요청에 receipt-bound owner direction 원문이 없거나 fiction invocation receipt가
동일 production input receipt를 갖지 않으면 canon commit 전에 거절한다.

`production-run/v1`은 command binding, 실제 활성 Skill ID, Soul binding과 input
receipt의 상관관계를 검증한다. prompt/source 본문은 run에 저장하지 않는다.

## Firefly reference 정책

`inkos-long-writing`의 production 정책을 상업성 우선 방향으로 정렬했다.

- owner가 허가하고 Book에 결속한 private source의 정확한 문장, 리듬, 사건 배열,
  문체 예시는 선언된 slice와 role 안에서 Writer에게 제공할 수 있다.
- source 접근권은 canon 권한이 아니다. 결속되지 않은 고유명·사실·설정을 hard
  Book canon으로 자동 승격하지 않는다.
- authorized binding 안의 표면 겹침은 HIL 비교 정보다. 자동 감점, 억제, 강제
  거리두기, 자동 재작성 또는 상업적으로 강한 후보의 탈락 사유로 쓰지 않는다.

## 검증

- Phase 4 집중 회귀: 3 files, 16 tests PASS
- Core: 221 files, 2,459 tests PASS
- Studio: 61 files, 653 tests PASS
- CLI: 46 files, 251 tests PASS
- 합계: 3,363 tests PASS
- typecheck, build, semantic-pattern audit, publish manifest, diff check: PASS
- Studio fresh-session binding과 stale-session pre-model HTTP 409: PASS
- Soul append history, promoted append, missing pointer, symlink input, installed
  byte drift, operation expiry: PASS

## 최종 P0/P1 감리

감리 중 P1 한 건과 방어 보강 한 건을 구현 완료 전에 수정했다.

1. 같은 `decisionId`를 다른 결속에 재사용하면 과거 decision receipt가 덮여
   history 전체가 깨질 수 있었다. Book 안에서 decision ID 단회 사용을 강제하고
   두 번째 binding file이 생기지 않는 회귀를 추가했다.
2. configured Skill 목록을 읽은 뒤 package를 다시 읽는 사이 ID가 바뀌는 경우를
   실행 전 identity drift로 거절했다.

보정 후 회귀와 정적 감리에서 잔여 P0/P1은 없다. 현재 `promoted` 값은 owner
decision이 명시한 lifecycle 상태일 뿐 상업 품질을 자동 증명하지 않는다. 실제
Soul promotion 주장은 Phase 7의 source registry, deep-read, paired commercial
canary와 사람 HIL gate를 통과한 뒤에만 가능하다.

다음 재개점은 Phase 5의 HQ v2와 실행 표면 수렴이다. Phase 5 이후 단계는 아직
구현하지 않았다.
