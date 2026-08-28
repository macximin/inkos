# Production Kernel Phase 0 기준선

상태: Phase 0 완료

## 목적

이 문서는 Production Kernel 선택 이식 전에 현재 fork의 강점을 실행 가능한
characterization fixture로 고정한다. 이 단계에서는 production 동작, dependency,
Node 최소 버전, prompt, Skill 또는 LengthNormalizer를 바꾸지 않는다.

## 고정 기준

- 로컬 기준 commit: `44eeaeca508bf3aa6dffb1cf5a6a142e2b2042c8`
- upstream v1.8 benchmark: `091048383f411eb99948a8764f42b6fd13006f9b`
- InkOS package version: `1.7.2`
- package Node contract: `>=20.0.0`
- 검증 당시 host: Node `v22.23.1`, pnpm `11.1.2`
- machine-readable fixture:
  `packages/core/src/__tests__/fixtures/production-kernel-phase0-baseline.json`
- executable guard:
  `packages/core/src/__tests__/production-kernel-phase0-baseline.test.ts`

## 보존 계약과 실행 증거

| 영역 | 현재 정본·증거 | characterization |
| --- | --- | --- |
| Book/Arc/Rail | production baseline, ArcPacket, A/B Rail, reflow receipt | baseline·Arc·Rail·reflow tests |
| BookRules | provenance receipt와 effective rule projection | BookRules provenance/effective tests |
| 내용중립 | fiction-content invocation·outcome·authorization·operation manifest | fiction-content contract tests |
| reference/HIL | Book reference manifest, transformation candidate, Storyyard packet/decision | reference·Storyyard·CLI review tests |
| Chapter 내구성 | chapter/index/state/snapshot journal과 truth receipt | persistence·approval·truth tests |
| session/action/batch | JSONL metadata, confirmed action envelope, 단일 Book lock batch | session·action·batch tests |

현재 `write-next`는 active Rail이면 Chapter truth receipt가 필요하고, Rail이 없으면
readiness에서 `not-applicable`로 구분한다. Audit·HIL·reference에 Chapter truth
receipt를 보편 증거처럼 붙이지 않는다. capability별 기존 증거와 부족한 부분은
machine-readable fixture의 `completionEvidence`에 고정했다.

## 의도적으로 아직 채택하지 않은 upstream 변화

다음 항목은 전체 병합으로 우발 유입되지 않도록 현재 byte SHA를 고정했다.

- builtin prompt 변화
- production Skill binding과 Skill registry 변화
- 장편 writing Skill 변화
- LengthNormalizer 제거·대체
- Pi worker/stream과 upstream production harness

이 SHA는 영구 진리가 아니다. 해당 항목의 명시된 Phase가 시작될 때 diff와
승격 근거를 검토하고 fixture를 의도적으로 갱신한다.

## 현재 결손도 기준선으로 기록

- JSONL metadata는 합법적인 `null → Book`뿐 아니라 현재 `Book A → Book B`도
  마지막 값으로 복원한다. Phase 1은 전자를 유지하고 후자를 모델 호출 전에
  거절해야 한다.
- legacy action envelope는 `write_next.chapterCount=1..20`을 허용하고 batch 전체가
  Book lock 하나를 쓴다. Phase 3의 `write-next/v1`은 1화만 허용하고 batch는 별도
  parent/child operation 계약으로 분리한다.
- Skill registry는 현재 last-write-wins다. Phase 4 전까지 이를 몰래 바꾸지 않는다.

## 검증 결과

최종 커밋 전 아래 명령을 다시 실행하고 이 표를 실제 readback으로 갱신한다.

| gate | 결과 |
| --- | --- |
| `pnpm test` | PASS: Core 2424, Studio 650, CLI 251 — 총 3325 tests |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS; 기존 Studio chunk-size warning 유지 |
| `pnpm audit:semantic-patterns` | PASS; 기존 후보 26건을 출력하고 exit 0 |
| `pnpm verify:publish-manifests` | PASS: Core, CLI, Studio |
| `git diff --check` | PASS |

## 완료선

Phase 0는 위 gate가 모두 green이고, runtime 동작 변경 없이 fixture·test·이 문서만
남을 때 완료다. 그 전에는 Phase 1 구현을 시작하지 않는다.
