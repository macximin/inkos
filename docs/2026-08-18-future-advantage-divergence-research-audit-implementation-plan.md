# 미래 선점·역사 분기·고증 검색 구현안

- 상태: P0~P7 시스템 구현·검증 완료. 현재 작품 적용은 사람 승인 대기
- 작성일: 2026-08-18
- 대상: InkOS Core + Studio
- 범위: 시스템 계약, 검색 라우팅, Arc/회차 감리, 런타임 정본
- 미실행 범위: 현재 작품 자동 마이그레이션, 원고 수정, Tavily 키 설치

## 2026-08-20 완료 영수증

- 구현 단계: P0~P7 완료
- 최종 구현 기준 커밋: `3d78b532 feat(core): validate future advantage canaries`
- 전체 테스트: Core 2026 + Studio 642 + CLI 243 = 2911 PASS
- Core·Studio·CLI 타입 검사 및 프로덕션 빌드: PASS
- 패키지 manifest, 변경문법, `git diff --check`: PASS
- 기술·금융·경영·유통·문화·인재·정책·복합 8종 카나리: PASS
- 허용된 선점을 `실제 역사보다 빠르다`는 이유만으로 탈락시킨 사례: 0개
- 무손실 예언은 구체적인 기억 열화 위험, 구현 생략은 실행 다리 누락 gate로 보완 요구
- 정보 경계 위반은 창작 critical로 차단
- snapshot·restore·회차 삭제 뒤 작품 장부와 고증 receipt 동시 복원: PASS
- 현재 작품·Tavily 키·자격 증명: 자동 변경 없음

## 현재 작품 라이브 상태

- 실제 작품 경로: `/Users/a2501/Desktop/firefly_studio/edge_repos/inkos/books/imf를-독식한-재벌-3세`
- `books/`는 Git 제외 작업 데이터이며 이번 문서 커밋에 포함하지 않는다.
- 작품 상태: `active`, 언어 `ko`, 장르 `현대판타지 재벌물`
- 현재 회차: 1화 `미처리함`, `ready-for-review`, 한국어 글자 수 4295
- 현재 감리 메모: 1996년 시대 배경 일부가 고증 확인 필요 상태이나 검색 도구 없이 교차 확인하지 않았음
- `book_rules.md`에 미래 선점 절 없음
- `story/future_advantage_ledger.json` 없음
- `story/research/future_advantage_receipts.json` 없음
- 따라서 P0~P7 시스템은 준비됐지만 이 작품에는 아직 적용되지 않았다.
- `/Users/a2501/Desktop/inkos`는 Git 저장소가 아니며 같은 slug의 빈 디렉터리 골격만 있다. 재개 시 이를 실제 작품 경로로 혼동하지 않는다.

## 결론

회귀·빙의·예지형 작품에서 미래의 기술, 금융 방식, 경영 기법, 유통 구조, 문화 포맷, 정책 변화, 인재를 먼저 가져오는 행위는 고증 오류가 아니라 핵심 보상 엔진이다.

InkOS는 이를 단순한 `시대 고증 예외`로 처리하면 안 된다. 아래 네 층을 분리해야 한다.

1. **실제 역사 기준선**: 개입 전 당시 무엇이 존재했고 무엇이 병목이었는가.
2. **주인공의 미래 기억**: 무엇을 알고 무엇을 모르며, 그 기억은 얼마나 믿을 만한가.
3. **허용된 미래 선점**: 현재 자원으로 무엇을 얼마나 먼저 실행하는가.
4. **분기 후 작품 정본**: 실행 뒤 실제 역사와 달라진 세계에서 무엇이 새 사실이 되었는가.

외부 검색은 1번만 검증한다. 검색 결과가 2~4번을 금지하거나 작품 정본을 직접 고칠 수는 없다.

## 현재 구현의 문제

### 1. 장르 설정 하나가 모든 회차 감리에 검색을 강제한다

`packages/core/genres/chaebol-modern-fantasy-ko.md:9`의 `eraResearch: true` 때문에 `packages/core/src/agents/continuity.ts:665-668`은 모든 회차 감리에서 `chatWithSearch()`를 호출한다. 회차에 검증할 실제 역사 주장이 없어도 검색한다.

### 2. 검색어가 사실 주장이 아니라 감리 프롬프트다

`packages/core/src/agents/base.ts:72-77`은 마지막 사용자 메시지의 앞 200자를 검색어로 쓴다. 현재 메시지는 상태 카드와 회차 원고를 포함한 감리 프롬프트이므로, 검색 질의가 `1996년 김포공항 국제선 운항` 같은 원자적 질문이 아니라 `Review chapter 1...`에 가깝다.

### 3. Studio 검색 설정과 회차 감리가 서로 다른 경로를 쓴다

Studio가 저장하는 `researchSearch` 설정은 `packages/core/src/agent/agent-tools.ts:1165-1179`의 `research_web`에서만 읽는다. 회차 감리의 `chatWithSearch()`는 이 설정을 받지 않고 환경변수 `TAVILY_API_KEY`만 찾는다. 따라서 Studio에 키를 넣어도 현재 회차 감리 검색은 같은 키를 사용한다고 보장할 수 없다.

### 4. 현재 연구 보고서의 claim은 검증된 원자 주장이라고 보기 어렵다

`packages/core/src/agents/researcher.ts:97-101`은 각 검색 결과의 첫 문장을 claim으로 만든다. 한 claim에 한 source만 연결되고, `conflicts`는 실질적으로 계산되지 않는다. `packages/core/src/agents/researcher.ts:135-140`의 질의 힌트도 한국어 프로젝트에서 중국어로 고정되어 있다.

### 5. 작품 규칙에는 허용된 역사 분기를 표현할 자리가 없다

`packages/core/src/models/book-rules.ts:20-24`의 시대 제약은 `enabled`, `period`, `region`만 가진다. `packages/core/src/agents/continuity.ts:171-178`도 해당 시대 표시만 붙인다. 당시 없었던 것을 의도적으로 먼저 만든 것인지, 원고가 실수로 당시 존재했다고 쓴 것인지 구분하지 못한다.

### 6. Arc는 보상과 세계 변화를 담지만 선점의 인과 다리를 명시하지 않는다

`packages/core/src/arc/schema.ts:18-48`에는 `obstacle`, `pressure`, `payoff`, `irreversibleChange`, `worldChanges`가 있지만, 실제 역사 기준선과 주인공의 기억, 구현 병목, 선행 도입 증거를 분리하는 계약이 없다.

## 조사 근거

- [Counterfactual Story Reasoning and Generation](https://aclanthology.org/D19-1509/)은 반사실적 개입 이후 이야기가 인과 사슬과 모순되지 않게 바뀌어야 하며, 개입과 무관한 부분은 보존되어야 한다고 본다. InkOS에서는 이를 `개입 이후의 분기 정합성`과 `기준선 보존`으로 적용한다.
- [FActScore](https://aclanthology.org/2023.emnlp-main.741/)는 긴 글 전체를 사실/거짓 하나로 판정하는 대신 원자적 사실로 분해해 근거와 대조한다. 회차 전체 검색 대신 검증 가능한 기준선 주장만 뽑아야 한다는 근거다.
- [RARR](https://aclanthology.org/2023.acl-long.910/)은 연구와 수정을 분리하고, 근거 없는 부분만 최소 수정해 나머지 결과를 보존한다. 검색 결과가 원고 전체를 재작성하거나 작품의 핵심 가정을 지워서는 안 된다는 근거다.
- [Tavily 검색 권장사항](https://docs.tavily.com/documentation/best-practices/best-practices-search)은 짧고 초점이 분명한 질의에는 `basic`, 복합적이고 세부적인 질의에는 `advanced`를 권장하고, 검색 후 필요한 페이지를 별도로 추출하는 2단계 흐름을 제시한다. 현재의 프롬프트 앞 200자 검색은 이 방향과 맞지 않는다.

위 연구는 검색·반사실 추론의 구조를 뒷받침한다. `재미 우선`의 심각도 정책과 A/B 레일 적용은 InkOS 작품 제작 목적에 맞춘 설계 판단이다.

## 핵심 용어

### 미래 선점 계약

작품 전체에서 주인공 또는 주요 인물이 미래 정보를 어떤 범위와 한계로 사용할 수 있는지를 정하는 작품 규칙이다.

### 미래 선점 move

한 Arc에서 미래 정보를 이용해 실제 역사보다 먼저 실행하는 구체적 행동 단위다. 기술 발명만 뜻하지 않는다.

- `introduce`: 당시 없던 제품·제도·형식을 처음 도입
- `adopt`: 이미 가능하지만 보급 전인 방식을 먼저 채택
- `position`: 예정된 사건 전에 자산·계약·지위를 선점
- `acquire`: 저평가될 자산·기업·권리를 먼저 확보
- `recruit`: 미래의 핵심 인재를 먼저 영입
- `shape`: 정책·시장·문화의 형성 과정에 개입

### 기준선 claim

실제 역사에서 검색으로 검증할 수 있는 짧은 주장이다. 예: `1996년 국내 기업이 일반적으로 사용한 팩스·결재 절차`, `특정 금융 제도의 시행 시점`.

### 분기 정본

미래 선점 move가 본문에서 실행된 뒤 작품 세계 안에서 새로 확정된 사실이다. 실제 역사 검색 결과보다 우선한다.

## 권위와 우선순위

| 층 | 예시 | 권위 | 검색으로 변경 가능 여부 |
| --- | --- | --- | --- |
| 작품 계약 | 미래 지식 범위, 금지된 지름길 | `book_rules.md` | 불가 |
| 분기 후 정본 | 이미 확보한 회사, 바뀐 정책, 사라진 경쟁사 | 미래 선점 장부 + 현재 상태 | 불가 |
| Arc 의도 | 이번 선점의 목표·다리·보상 | 활성 Arc | 불가. 기준선 근거만 보충 |
| 실제 역사 기준선 | 당시 제도·가격·기술·관행 | claim receipt | 가능 |
| 검색 추정·미확인 | 단일 출처, 충돌 자료 | research evidence | 정본 승격 불가 |

주인공의 기억은 검색으로 보장되는 사실이 아니다. `작품이 허용한 정보 자산`이며, 정확도와 범위는 작품 계약과 분기 진행에 따라 달라진다.

## 데이터 계약

### 1. `book_rules.md`에 선택적 `미래 선점` 절 추가

기존 5-SECTION 건축 계약은 유지한다. 새 foundation 파일을 추가하지 않고 `book_rules` 안에 짧은 실행 규칙을 넣는다.

```md
## 미래 선점

- 핵심 재미: 미래의 승자를 맞히는 데서 끝나지 않고 현재의 돈·사람·권한으로 먼저 실행해 소유권을 얻는다.
- 회귀 기준 시점: 1996년 11월
- 허용 분야: 금융, 제조, 경영, 유통, 콘텐츠, 인재, 정책 대응
- 알고 있는 것: 큰 사건의 방향, 미래 승자의 정체, 성공한 방식의 원리
- 모르는 것: 정확한 날짜와 숫자 전부, 개입 후 달라진 결과, 전문 실무의 세부
- 금지된 지름길: 공급망·법적 권한·자금·전문가 없이 완제품을 즉시 구현
- 기억 원칙: 관련 분야에 큰 분기를 만들수록 이후 기억의 신뢰도가 낮아진다.
- 검색 정책: 실제 역사 기준선만 검증하며 허용된 선점을 시대 오류로 판정하지 않는다.
```

`BookRulesSchema`에는 선택적 `futureAdvantage`를 추가한다.

```ts
futureAdvantage?: {
  enabled: boolean;
  originMoment?: string;
  corePromise?: string;
  allowedDomains: string[];
  known: string[];
  unknown: string[];
  forbiddenShortcuts: string[];
  memoryPolicy?: string;
  researchPolicy: "off" | "on-demand" | "required-for-hard-claims";
}
```

기존 책에는 필드가 없으므로 현재 동작을 유지한다. 한국어·영어·중국어 Markdown parser를 모두 지원하되, 한국어 작품은 한국어 표제를 정본으로 생성한다.

### 2. ArcPacket에 선택적 `futureAdvantageMove` 추가

```ts
futureAdvantageMove?: {
  moveId: string;
  mode: "introduce" | "adopt" | "position" | "acquire" | "recruit" | "shape";
  domain: string;
  target: string;
  rememberedOutcome: string;
  baselineQuestions: string[];
  bridgeSteps: string[];
  resistance: string[];
  proof: string;
  reward: string;
  downstreamConsequences: string[];
}
```

기존 Arc v1을 깨지 않도록 optional 필드로 시작한다. `status=ready` 전 검사에서 아래만 요구한다.

- `rememberedOutcome`과 `baselineQuestions`가 섞이지 않았는가.
- `bridgeSteps`에 현재 시대의 돈·사람·설비·법적 권한·유통·신뢰 중 필요한 항목이 있는가.
- `proof`와 `reward`가 독자가 확인할 수 있는 장면인가.
- `downstreamConsequences`가 B 레일 또는 다음 Arc 압력으로 이어지는가.

### 3. 미래 선점 고증 receipt는 작품 정본과 분리 저장

경로:

```text
story/research/future_advantage_receipts.json
```

```ts
{
  claimId: string;
  moveId?: string;
  atomicClaim: string;
  claimType: "baseline" | "prerequisite" | "institution" | "cost" | "adoption";
  timelineLayer: "real-history-baseline";
  asOf?: string;
  verdict: "supported" | "disputed" | "unknown";
  confidence: "low" | "medium" | "high";
  sourceIds: string[];
  accessedAt: string;
  queryLog: string[];
}
```

receipt는 참고 근거다. 자동으로 `book_rules`, Arc, 회차 원고, 작품 장부를 수정하지 않는다. 명시적 `research_web` 경로와 회차 창작 감리는 계속 분리한다.

### 4. 분기 후 정본은 미래 선점 장부에 기록

승인된 회차에서 실제 실행된 move만 구조화 정본에 올린다.

```text
story/future_advantage_ledger.json
```

필수 항목:

- move id와 분야
- 처음 계획한 선점
- 본문에서 실제로 실행된 단계
- 독자에게 제시된 증거
- 획득한 돈·지분·권한·인재·평판
- 발생한 후폭풍
- 영향을 받은 실제 역사 기준선의 범위
- 해당 분야 미래 기억의 현재 신뢰도

이 장부는 런타임 정본이다. chapter snapshot, restore, rollback, delete에 포함한다. 검색·고증 상태는 `story/research/future_advantage_receipts.json`에 따로 둔다.

### 5. ChapterIntent와 trace에 move 연결

```ts
futureAdvantageMoveIds?: string[];
researchClaimIds?: string[];
authorizedDivergences?: string[];
```

이 값은 planner가 Arc와 장부에서 가져온다. writer·auditor·reviser가 같은 선점 계약을 사용했는지 trace로 확인할 수 있어야 한다.

## A/B 레일 적용

### A 레일: 선점과 보상

`기억 → 선택 → 구현 다리 → 저항 돌파 → 증거 → 보상`

예:

`미래의 물류 승자를 기억함 → 당시 가능한 창고·전산·계약을 조립함 → 기존 유통사 반발 → 재고회전율로 증명 → 유통망과 지분 확보`

### B 레일: 후폭풍과 기억 열화

`경쟁자 대응 → 역사 변형 → 새 피해·새 기회 → 미래 기억 신뢰도 하락`

A 레일만 반복하면 주인공이 정답지를 읽는 작품이 된다. B 레일은 선점을 벌주는 장치가 아니라 다음 승부를 새롭게 만드는 압력이다.

## 검색 라우팅

### 검색을 실행하는 경우

1. 활성 Arc에 `futureAdvantageMove.baselineQuestions`가 있고 아직 receipt가 없을 때.
2. chapter memo가 가격·날짜·법·제도·기술 보급 시점처럼 명시적인 실제 역사 주장을 사용할 때.
3. 사용자가 `고증 감리`를 명시적으로 요청할 때.

### 검색하지 않는 경우

- 일반 문체 감리
- 캐릭터·복선·보상·회차 목표 정합성 감리
- 이미 receipt가 있고 유효 범위가 바뀌지 않은 claim
- 작품 계약이 허용한 선점 자체의 옳고 그름
- 분기 후 작품 세계의 사실

### 검색 실행 방식

1. 원고 전체가 아니라 원자적 `baselineQuestions`를 질의로 만든다.
2. 프로젝트 언어에 맞는 짧고 구체적인 검색어를 쓴다.
3. 기본은 Tavily `basic`; 자료가 희소하거나 출처가 충돌할 때만 `advanced`를 쓴다.
4. 검색 URL을 모은 뒤 필요한 페이지를 별도로 추출한다.
5. 중요한 claim은 독립된 출처 2개를 요구한다. 한 출처만 있으면 `low/unknown`으로 둔다.
6. 출처 충돌을 숨기지 않고 `disputed`로 남긴다.

### 검색 키가 없을 때

- 회차 감리를 실패시키지 않는다.
- 매 감리마다 같은 경고를 출력하지 않는다.
- 프로젝트 단위로 `researchStatus=unavailable`을 한 번 표시한다.
- `required-for-hard-claims`인 claim만 사람 검토 대기 상태로 남긴다.
- 일반 집필과 창작 감리는 계속할 수 있다.

### 현재 검색 설정 경로 통합

`readResearchSearchConfig()`를 agent-tools 내부 함수로 두지 않고 Core 공용 모듈로 옮긴다. `research_web`와 claim researcher가 같은 설정을 사용한다. ContinuityAuditor는 `chatWithSearch()`를 직접 부르지 않는다.

## 감리 정책

### 감리 질문

미래 선점 회차는 `당시에 존재했는가` 하나로 심사하지 않는다.

1. 주인공의 기억 범위 안에 있는가.
2. 그 기억을 현재의 선택으로 번역했는가.
3. 돈·사람·설비·제도·권한·유통·신뢰의 병목을 통과했는가.
4. 상대가 자기 정보와 이해관계 안에서 저항했는가.
5. 독자가 확인할 증거와 보상이 나왔는가.
6. 그 개입이 다음 역사와 미래 기억을 어떻게 바꿨는가.

### 이중 결과

`AuditResult.passed` 하나에 창작 품질과 고증 상태를 합치지 않는다.

```ts
{
  passed: boolean; // 창작·정합성 통과 여부
  researchStatus?: "not-needed" | "supported" | "disputed" | "unknown" | "unavailable";
  researchClaimIds?: string[];
}
```

### 심각도

| 상황 | 심각도 | 자동 수정 |
| --- | --- | --- |
| 작품 계약이 허용한 선점이 실제 역사보다 빠름 | 문제 아님 | 금지 |
| 주인공이 계약상 모르는 미래 정보를 근거 없이 앎 | critical | 구조 수정 후보 |
| 개입 전부터 미래 결과물이 이미 보편적으로 존재했다고 씀 | critical | 해당 장면만 수정 |
| 분기 장부와 현재 회차가 모순됨 | critical | 구조 수정 후보 |
| 명시적 금지 지름길로 절차·공급망·권한을 건너뜀 | critical | 구조 수정 후보 |
| 구현 다리가 얇거나 상대 저항이 약함 | warning | 자동 재작성 금지, 제안만 |
| 보상이 추상적이고 증거가 없음 | warning | Arc/회차 보강 제안 |
| 실제 역사 claim이 미확인·충돌 상태 | info 또는 별도 research 상태 | 원고 자동 수정 금지 |
| 분기 이후 실제 역사와 달라짐 | 문제 아님 | 금지 |

`불가능해 보인다`는 모델의 주관만으로 critical을 만들 수 없다. critical은 작품 계약·정보 경계·런타임 정본·명시적 금지와의 증명 가능한 모순에만 사용한다.

## 파이프라인

### 1. Foundation

- Architect가 회귀·예지·미래 지식이 핵심 재미인지 판정한다.
- 맞으면 `book_rules.md#미래 선점`을 생성한다.
- 실제 역사 기준선과 미래 기억을 같은 문장으로 합치지 않는다.

### 2. Arc

- Arc 설계 시 optional `futureAdvantageMove`를 만든다.
- A 레일에는 구현과 보상을, B 레일에는 저항·후폭풍·기억 열화를 둔다.
- 실제 역사 검증이 필요한 부분은 서술문이 아니라 `baselineQuestions`로 분리한다.

### 3. Research preflight

- unresolved baseline question만 claim으로 분해한다.
- 기존 project-level search provider로 검색한다.
- receipt를 저장하되 작품 정본은 건드리지 않는다.
- 검색 실패는 `unknown/unavailable`로 끝내고 창작 감리로 되돌아간다.

### 4. Planner / Composer

- 활성 move, 관련 분기 장부 행, 필요한 receipt만 context package에 넣는다.
- `book_rules`와 분기 장부는 hard/protected context다.
- 실제 역사 receipt는 diagnostic evidence이며 author intent와 허용된 분기를 덮어쓸 수 없다.

### 5. Writer

- `미래 결과를 아는 것`과 `현재 구현 방법을 아는 것`을 분리한다.
- 구현 다리는 장면·대사·계약·수치·실패로 보여 준다.
- receipt에 없는 세부 숫자를 임의로 단정하지 않는다.

### 6. Auditor / Reviser

- Auditor는 live web search를 하지 않고 준비된 receipt와 분기 장부를 읽는다.
- 고증 미확인은 별도 research 상태로 반환한다.
- Reviser는 허용된 선점을 지우거나 실제 역사로 되돌리지 않는다.
- 수정은 검증되지 않은 사실 문장 또는 계약과 모순된 구현 단계만 최소 범위로 한다.

### 7. Settler

- 본문에서 실제로 발생한 선점 단계만 장부에 반영한다.
- 계획했으나 실행되지 않은 내용은 정본으로 승격하지 않는다.
- 세계 변화와 미래 기억 신뢰도 변화에 본문 근거가 있는지 StateValidator가 검사한다.

## Studio 최소 UI

새 대시보드는 만들지 않는다.

- `기획서` 화면: 작품의 미래 선점 계약을 읽기 전용으로 표시
- `아크지도` 카드: A 레일 `선점/보상`, B 레일 `후폭풍/기억 열화` 표시
- 회차 감리: `창작 감리`와 `고증 상태` 배지 분리
- 프로젝트 설정: 기존 Research Search Provider를 한국어화하고 연결 상태만 표시
- claim 근거: 필요할 때만 펼치는 출처 목록

## 구현 순서

### P0. 계약과 회귀 테스트

상태: 2026-08-18 완료.

대상:

- `packages/core/src/models/book-rules.ts`
- `packages/core/src/arc/schema.ts`
- `packages/core/src/models/input-governance.ts`

완료 조건:

- 기존 책과 기존 Arc가 변경 없이 parse된다.
- 한국어 `미래 선점` 절이 구조화된다.
- optional future move가 없는 작품은 기존 파이프라인과 동일하다.

### P1. 검색 경계 복구

상태: 2026-08-18 완료. 회차 감리는 준비된 근거만 읽고, 명시적 `research_web`만 프로젝트 언어와 `researchSearch` 설정을 사용한다.

대상:

- `packages/core/src/agents/continuity.ts`
- `packages/core/src/agents/base.ts`
- `packages/core/src/utils/web-search.ts`
- `packages/core/src/agents/researcher.ts`
- 새 공용 search config reader

완료 조건:

- `eraResearch=true`만으로 회차 전체 검색을 하지 않는다.
- Studio 설정과 claim research가 같은 provider/key 경로를 쓴다.
- 한국어 프로젝트의 질의가 중국어 힌트를 붙이지 않는다.
- 키 없음이 회차 감리 실패나 반복 경고가 되지 않는다.

### P2. Foundation과 Arc

상태: 2026-08-20 완료.

대상:

- `packages/core/src/agents/architect.ts`
- Arc 생성·편집 계약과 Studio Arc 화면

완료 조건:

- 회귀/예지물이 미래 선점 계약을 생성한다.
- 기술 외 금융·경영·유통·문화·인재·정책 사례도 같은 move로 표현된다.
- Arc ready 검사가 구현 다리와 보상을 확인한다.

### P3. Context와 집필

상태: 2026-08-20 완료.

대상:

- `packages/core/src/agents/planner.ts`
- `packages/core/src/agents/composer.ts`
- `packages/core/src/utils/context-assembly.ts`
- `packages/core/src/agents/writer.ts`

완료 조건:

- writer가 관련 move와 장부 행만 받는다.
- 연구 근거가 author intent보다 높은 규칙으로 오르지 않는다.
- trace에 move/claim id가 남는다.

### P4. 감리·수정

상태: 2026-08-20 완료.

대상:

- `packages/core/src/agents/continuity.ts`
- `packages/core/src/pipeline/chapter-review-cycle.ts`
- `packages/core/src/pipeline/runner.ts`
- `packages/core/src/agents/reviser.ts`

완료 조건:

- 의도된 조기 도입이 시대 오류로 차단되지 않는다.
- 창작 통과와 research 상태가 분리된다.
- 검색 미확인만으로 자동 재작성이 실행되지 않는다.

### P5. 분기 장부 정본화

상태: 2026-08-20 완료.

대상:

- state schemas/store/bootstrap/projection
- snapshot/rollback/delete/truth receipt
- chapter analyzer/settler/state validator

완료 조건:

- 실행된 move만 정본화된다.
- 롤백하면 분기 장부도 같은 회차로 돌아간다.
- 실제 역사 receipt는 롤백 정본에 섞이지 않는다.

### P6. Studio 표시

상태: 2026-08-20 완료.

기획서·아크지도·회차 감리에 최소 표시만 추가한다. 별도 관리 페이지는 만들지 않는다.

### P7. 카나리

상태: 2026-08-20 완료. 시스템 카나리는 통과했고 현재 작품 승격은 사람 승인 대기다.

현재 《IMF를 독식한 재벌 3세》에는 자동 적용하지 않는다. 별도 카나리 책 또는 복구 가능한 복제본에서 검증한 뒤 사람 승인으로 승격한다.

## 카나리 행렬

| 분야 | 선점 예 | 반드시 보는 구현 다리 | 기대 감리 |
| --- | --- | --- | --- |
| 기술 | 미래 제품·공정을 조기 상용화 | 소재, 설비, 전문가, 특허, 양산 | 시기가 빠르다는 이유로 차단하지 않음 |
| 금융 | 위기 전 자산 포지션·부실채권 선점 | 자금 출처, 규제, 계약, 리스크 | 무손실 예언이면 경고, 계약과 손실 가능성이 있으면 허용 |
| 경영 | 공급망·성과관리 방식을 조기 도입 | 조직 저항, 데이터, 권한, 비용 | 용어만 미래형이면 경고, 실행 장면이 있으면 허용 |
| 유통 | 회원제·물류망·온라인 주문 조기 도입 | 인프라, 결제, 창고, 고객 습관 | 채택 저항과 첫 증거를 확인 |
| 문화 | 미래 콘텐츠 포맷·팬덤 사업 선점 | 제작 인력, 유통 채널, 대중 반응 | 미래 유행 자체를 검색으로 부정하지 않음 |
| 인재 | 미래 거물 조기 영입 | 접근 경로, 설득 조건, 현재 능력 | 이름만 안다고 충성하면 경고 |
| 정책 | 예정된 제도 변화 전 대응 | 법적 가능 범위, 정보 경계, 이해관계자 | 제도 시행 전 활용과 시행 전 준비를 구분 |
| 복합 | 금융 선점이 제조·정책·인재 지도를 바꿈 | move 간 인과와 분기 장부 | 실제 역사 기준선을 현재 정본으로 오인하지 않음 |

## 안정성 감리 기록

사용자 요구에 따라 결론이 두 번 연속 실질 변경되지 않을 때까지 반례 감리를 반복했다.

### 감리 1 — 기술 중심 설계 반박

반례: 금융 포지션, 미래 인재 영입, 문화 포맷, 정책 대응은 `기술 조기 도입`으로 표현되지 않는다.

변경:

- `기술 조기 도입`에서 분야 중립적 `미래 선점 move`로 일반화
- move mode를 introduce/adopt/position/acquire/recruit/shape로 분리
- 보상뿐 아니라 구현 다리와 상대 저항을 필수화

판정: **실질 변경 발생. 안정 카운트 초기화.**

### 감리 2 — 실제 역사 검색의 권위 반박

반례: 첫 개입 이후 실제 역사 검색 결과는 작품 세계의 현재 사실이 아니다. 검색이 이를 정답으로 취급하면 핵심 재미와 후속 분기를 지운다.

변경:

- 실제 역사 기준선 / 주인공 기억 / 허용된 개입 / 분기 후 정본을 분리
- research evidence를 diagnostic으로 낮추고 분기 장부를 hard truth로 승격
- 창작 passed와 research 상태를 분리
- Auditor의 live full-prompt search를 제거

판정: **실질 변경 발생. 안정 카운트 초기화.**

### 감리 3 — 분야·서사 반례 재검증

반례:

- 당시 공급망으로는 어려운 20년 후 기술
- 물리적 발명이 필요 없는 금융·문화 선점
- 공개 자료가 없는 비밀 정보
- 미래 거물의 현재 능력이 아직 부족한 인재 영입
- 선점 여러 개가 서로의 미래 기억을 망가뜨리는 복합 분기

결과:

- 어려운 기술은 `bridgeSteps/resistance`와 warning 정책으로 처리됨
- 금융·문화·인재는 move mode로 처리됨
- 비공개·미확인은 `unknown`이며 사용자 승인 가정을 검색이 삭제하지 않음
- 복합 분기는 분기 장부와 분야별 기억 신뢰도로 처리됨

판정: **실질 변경 없음. 안정 카운트 1.**

### 감리 4 — 운영 장애 반례 재검증

반례:

- Tavily 키 없음
- 검색 결과 충돌·저품질·단일 출처
- 오래된 receipt
- 기존 책과 Arc에 새 필드가 없음
- 회차 롤백·삭제 뒤 분기 장부가 앞서감
- 모델이 `불가능해 보인다`는 주관만으로 critical을 냄

결과:

- unavailable/disputed/unknown 상태가 창작 passed와 분리됨
- claim receipt는 정본을 자동 수정하지 않음
- 새 필드는 optional이며 기존 책은 fail-open
- 분기 장부는 state snapshot 계열에 들어가 롤백됨
- critical은 증명 가능한 계약·정보·정본 모순으로 제한됨

판정: **실질 변경 없음. 안정 카운트 2. 구현안 확정.**

## 최종 승인 기준

아래가 모두 통과해야 현재 작품에 적용할 수 있다.

1. 기존 Core 전체 테스트 통과.
2. 한국어 기획·집필·감리 결과에 중국어 사용자 노출 0개.
3. Tavily 키가 없어도 일반 감리와 집필이 정상 동작.
4. Tavily 키가 있으면 Studio 설정과 claim researcher가 같은 경로 사용.
5. 카나리 8개 분야에서 `시기가 빠르다`만으로 차단되는 사례 0개.
6. 금지된 지름길·정보 경계 위반·분기 정본 모순은 차단.
7. 검색 미확인만으로 원고 자동 재작성 0회.
8. snapshot/rollback/delete 뒤 분기 장부와 회차가 일치.
9. 현재 《IMF를 독식한 재벌 3세》는 사람 승인 전 자동 마이그레이션하지 않음.

## 현재 재개점

시스템 구현은 더 진행하지 않는다. 다음 행동은 사람의 명시적 작품 적용 승인이다.

승인 전에는 《IMF를 독식한 재벌 3세》의 `book_rules.md`, 기획서, Arc, 원고, 장부를 수정하지 않는다. 승인된다면 기존 원고를 보존한 복구 가능한 카나리에서 미래 선점 계약을 추가하고 Forecast/Arc를 먼저 검토한다. 본문 실행 move는 해당 회차가 승인될 때만 장부 정본으로 승격한다.

Tavily 키 연결은 작품 승격과 별개다. 실제 역사 기준선 조사가 필요할 때 사용자가 명시적으로 승인한 `research_web` 경로에만 연결한다.
