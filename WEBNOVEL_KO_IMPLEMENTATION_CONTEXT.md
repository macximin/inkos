# InkOS 한국어 웹소설 제작기 구현 컨텍스트

- 작성일: 2026-08-09
- 대상 저장소: `/Users/a2501/Desktop/inkos`
- 문서 목적: 새 Codex 세션이 이전 논의를 반복하지 않고 바로 구현을 이어가기 위한 인수인계
- 최종 결정: **InkOS를 웹소설 집필의 본체로 사용한다.**

## 새 세션이 가장 먼저 알아야 할 것

이 프로젝트의 우선순위는 보안 체계, 다중 저장소 권위, 승인 거버넌스가 아니다.

**가장 중요한 목표는 한국어 웹소설을 실제로 빠르게 기획하고, 쓰고, 감리하고, 고치는 것이다.**

이전에는 Firefly Foundry와 Command Center를 중심에 두고 InkOS 기능을 선별 이식하는 방향을 검토했다. 이 방향은 폐기한다. 현재 결정은 다음과 같다.

1. InkOS가 일상 집필 UI이자 작품 작업의 본체다.
2. `Book = 작품`, `Chapter = 개별 회차 원고`라는 InkOS의 기존 개념은 유지한다.
3. 그 사이에 `Arc = 1~3화 제작 단위`를 1급 객체로 추가한다.
4. 사용자 표면은 **기획서 → Arc → 원고**의 3단 구조로 만든다.
5. 문체, 캐릭터, 복선, 자료, 전개 예측, 감리, 수정, 버전 기능은 이 3단 구조를 돕는 보조 기능으로 둔다.
6. Foundry, Command Center, Storyyard 연동은 현재 구현 범위에서 제외한다.
7. 기존 Firefly 저장소는 삭제하지 않고 보관만 한다. InkOS 구현을 위해 수정할 필요가 없다.
8. 이 결정을 다시 아키텍처 토론으로 되돌리지 않는다. 실제 코드에서 치명적인 불가능이 확인될 때만 재논의한다.

## 제품 목표

사용자는 한 앱 안에서 다음 흐름을 끝낼 수 있어야 한다.

```text
작품 생성
  → 기획서 작성 또는 AI 보조 생성
  → 1~3화 Arc 설계 및 전개 후보 비교
  → 회차별 원고 생성
  → 문체·캐릭터·연속성 감리
  → 필요한 부분만 수정
  → 버전 저장
  → 다음 Arc 또는 다음 회차 계속 집필
```

API 키 결제는 필수 조건이 아니다. 로컬에 로그인된 Codex CLI의 ChatGPT 구독 인증을 InkOS의 모델 실행 경로로 사용할 수 있어야 한다.

## 핵심 정보 구조

### 1. 기획서

작품 전체가 지켜야 할 장기 계약이다. 최소한 다음 정보를 다룬다.

- 제목과 한 줄 전제
- 장르와 독자층
- 주인공의 욕망, 능력, 결핍
- 작품의 반복 재미 엔진
- 주요 인물과 관계
- 세계관 핵심 규칙
- 장기 진행 방향과 결말 가설
- 반드시 유지할 요소
- 피해야 할 요소
- 작품 공통 문체 계약

기존 InkOS의 `story_frame.md`, `volume_map.md`, 역할 카드, `book_rules.md`, author intent 기능은 이 표면에 맞게 정리해 활용한다. 사용자에게 내부 파일 경로를 주된 정보 구조처럼 노출할 필요는 없다.

### 2. Arc

Arc는 **1~3화 안에 하나의 약속과 상태 변화를 완성하는 제작 단위**다. 단순 자유문장 `arcContext`가 아니라 안정적인 ID와 구조를 가진 객체여야 한다.

권장 최소 계약:

```ts
interface ArcPacket {
  id: string;
  title: string;
  status: "draft" | "ready" | "completed";
  episodeCount: 1 | 2 | 3;
  chapterNumbers: number[];

  openingState: string;
  promise: string;
  goal: string;
  obstacle: string;
  pressure: string;
  turn: string;
  payoff: string;
  irreversibleChange: string;
  nextHook: string;

  episodeBeats: Array<{
    chapterNumber: number;
    role: "promise" | "pressure" | "turn" | "payoff";
    beats: string[];
    endingHook: string;
  }>;

  characterChanges: string[];
  relationshipChanges: string[];
  worldChanges: string[];
  hookOperations: string[];
  mustKeep: string[];
  mustAvoid: string[];
  styleEmphasis: string[];
}
```

페이싱 기본형:

- 1화 Arc: 약속 → 압박/전환 → 보상과 상태 변화
- 2화 Arc: 1화 약속·잠금 → 2화 반전·보상·다음 훅
- 3화 Arc: 1화 약속 → 2화 압박·전환 → 3화 보상·상태 변화

기존 InkOS Forecast의 2~5개 분기 비교는 유지하되, 각 분기가 이 Arc 계약으로 변환될 수 있어야 한다. 선택한 Forecast는 즉시 원고나 상태를 덮어쓰지 않고 active Arc 초안이 된다.

### 3. 원고

기존 InkOS Chapter Markdown을 개별 회차 원고로 계속 사용한다.

원고 화면에는 다음 흐름이 있어야 한다.

- 현재 Arc와 해당 회차 비트 확인
- AI 초안 생성
- 직접 편집과 자동 저장
- 감리 결과 확인
- 문제별 부분 수정 제안
- 수정 전후 diff
- 버전 저장과 복원
- 다음 회차 계속 쓰기

원고가 Arc에 없는 중요한 설정을 새로 만들면 감리가 이를 표시하고, 사용자가 Arc 또는 기획서에 반영할지 선택할 수 있어야 한다.

## 반드시 살릴 InkOS의 장점

다음 기능은 삭제하거나 새로 약화시키지 않는다. 3단 구조에 맞춰 연결한다.

1. Planner → Composer → Writer → Observer/Reflector → Auditor → Reviser 제작 흐름
2. 자료를 실제 프롬프트에 넣기 전에 출처와 선택 이유를 정리하는 컨텍스트 컴파일
3. `mustKeep`, `mustAvoid`, `styleEmphasis` 입력 계약
4. 2~5개 비정본 전개 후보와 stale 감지
5. 인물, 관계, 정보 경계, 소품, 자원, 위치, 감정 상태 추적
6. 복선의 plant/advance/defer/resolve 상태와 의존성 추적
7. 감리 후 부분 수정, 실패 시 이전 최선 버전 복귀
8. 원고 버전, 백업, 복원
9. 자료 가져오기와 기존 작품 이어쓰기
10. 백그라운드 작업, 진행률, 중단, 재시도, 새로고침 후 복구

기능 이름이나 기존 중국어 중심 규칙을 그대로 신뢰하지 말고, 한국어 웹소설 생산에 실제로 도움이 되는지 테스트한다.

## 문체 기능 목표

현재 InkOS 문체 분석은 중국어와 영어에 맞춰져 있다. UI 번역만으로는 한국어 문체 기능이 완성되지 않는다.

문체는 다음 네 층으로 설계한다.

### 작품 문체

- 평균·중앙 문장 길이
- 문단 길이와 모바일 가독성
- 대사 비율
- 서술과 대사의 배치
- 자주 쓰는 종결 어미
- 시점과 서술 거리
- 속도감과 설명 밀도
- 반복 표현과 상투어
- 장면 시작·종료 패턴

### 캐릭터 화법

- 존댓말/반말과 상대별 변화
- 어휘 수준과 자주 쓰는 표현
- 문장 길이
- 감정이 올라갈 때의 말투 변화
- 말하지 않는 정보와 아는 정보
- 다른 인물과 구별되는 대사 특징

### Arc 문체

- 이번 1~3화의 감정 온도
- 코미디·긴장·감동 비율
- 장면 전환 속도
- 보상 장면에서 강조할 감각
- 클리프행어의 강도

### 회차 강조점

- `styleEmphasis`
- 이번 화에서 강화하거나 줄일 요소
- 직전 회차와 의도적으로 달라져야 하는 요소

이 문체 계약은 Writer, Auditor, Reviser가 모두 사용해야 한다. 단순 통계 화면으로 끝내지 않는다. 실제로 어떤 문체 계약이 투입됐는지 작업 결과에 남긴다.

## 한국어화 범위

한국어화는 Studio UI 문자열 교체만 뜻하지 않는다.

필수 범위:

1. `ko`를 Book/Project/Runtime State/Forecast/Genre/Length 계약에 추가
2. Planner, Composer, Writer, Auditor, Reviser, Forecast 프롬프트 한국어판
3. 한국어 문장 분리
4. 대사 추출
5. 어절 및 종결 어미 분석
6. 한국어 분량 계산 모드
7. 한국어 문체 fixture와 회귀 테스트
8. 주요 집필 흐름에서 중국어 fallback 제거
9. 오류, 빈 상태, 작업 진행, 확인 카드까지 완전 번역

번역 우선순위는 다음과 같다.

```text
작품 생성
→ 기획서
→ Arc
→ 원고 생성·편집
→ 문체
→ 감리·수정
→ 자료·Forecast·복원
→ 나머지 부가 기능
```

번역, 팬픽, 인터랙티브 영상 등 웹소설 핵심 흐름 밖의 제작 모드는 뒤로 미뤄도 된다.

## Codex ChatGPT 구독 실행 경로

현재 로컬 작업 트리에는 API 키 없이 Codex CLI의 ChatGPT 로그인을 사용하는 구현이 이미 진행되어 있다.

확인된 변경 범위:

- `packages/core/src/llm/codex-cli.ts`
- `packages/core/src/llm/providers/endpoints/codex.ts`
- `packages/core/src/llm/provider.ts`
- `packages/core/src/agent/agent-session.ts`
- Studio 서비스 목록, 연결 테스트, 모델 선택 UI
- 관련 Core/Studio 테스트

2026-08-09 읽기 전용 확인에서는 다음 상태였다.

- `codex-cli 0.145.0`
- `codex login status`: `Logged in using ChatGPT`
- API-key 인증을 구독 연결로 받지 않도록 분리
- Codex JSONL 응답 변환
- timeout/cancel과 프로세스 종료 처리
- 세션당 최대 8회 tool loop 제한
- Codex 자체 도구를 차단하고 InkOS 도구만 연결하는 실행 경계
- 자식 프로세스 환경변수 allowlist

새 세션은 이 구현을 지우거나 처음부터 다시 만들지 않는다.

먼저 현재 diff와 테스트를 읽고 다음을 확인한다.

- `codex` 명령 설치 여부
- `codex login status`가 ChatGPT 구독 로그인인지
- API-key 로그인은 구독 연결로 오인하지 않는지
- 일반 completion과 Agent tool loop가 모두 동작하는지
- 중단, timeout, 프로세스 종료, 최대 도구 라운드가 검증되는지

이 경로를 InkOS의 실제 기획·집필·감리 작업에서 선택할 수 있도록 완성한다.

## 현재 로컬 저장소 상태

문서 작성 시점의 기준:

- 저장소: `/Users/a2501/Desktop/inkos`
- 기준 커밋: `a6e05d4d docs: update Kimi K3 sponsorship copy`
- 작업 트리에는 기존 작업이 있다.
- 추적 파일 24개가 수정되어 있다.
- 새 파일 3개가 있다.
- 주요 내용은 부분 한국어 UI와 Codex ChatGPT 구독 연결이다.

이 변경은 사용자와 이전 세션의 작업이다.

**금지 사항:**

- `git reset --hard`
- 기존 변경 checkout/revert
- 다른 구현으로 덮어쓰기
- 사용자 확인 없이 삭제
- `git add .`

수정 전 `git status --short`, `git diff --stat`, 관련 diff를 읽고 기존 작업 위에서 이어간다.

## 구현 우선순위

### P0. 현재 변경 보존과 기준선 확보

- 기존 Codex 구독 연결과 한국어 변경을 읽는다.
- Core/Studio 관련 테스트를 실행한다.
- 전체 build, typecheck, lint, test의 현재 결과를 기록한다.
- 실패가 기존 실패인지 새 회귀인지 구분한다.

우선 재검증 명령:

```bash
pnpm --filter @actalk/inkos-core exec vitest run \
  src/__tests__/codex-cli.test.ts \
  src/__tests__/agent-session.test.ts \
  src/__tests__/providers-group.test.ts \
  src/__tests__/providers-schema.test.ts

pnpm --filter @actalk/inkos-studio exec vitest run \
  src/api/server.test.ts \
  src/pages/service-detail-state.test.ts

pnpm typecheck
pnpm build
pnpm test
```

### P1. 핵심 집필 흐름 완전 한국어화

- 작품 생성부터 원고 수정까지 중국어 fallback을 제거한다.
- core language에 `ko`를 추가한다.
- 한국어 프롬프트와 분량 계산을 연결한다.
- 한국어 문체 분석을 구현한다.

### P2. Arc를 1급 객체로 추가

- Arc schema와 저장소
- Book과 Chapter 참조
- 1~3화 검증
- Arc 목록/카드/타임라인
- active Arc 편집기
- 회차별 비트 편집
- Forecast → Arc 초안 변환
- 원고 생성 시 Arc context 주입

### P3. 실제 생산 루프 완성

- 기획서 보조 생성
- Arc 생성과 비교
- Codex 구독 기반 원고 생성
- 문체·캐릭터·연속성 감리
- 국소 수정과 diff
- 버전 저장·복원
- 다음 회차 및 다음 Arc 이어쓰기

### P4. 장편 운영 기능 다듬기

- 복선·관계·정보 상태 작업판
- 기존 작품 import
- 자료 검색 및 선택
- 품질 추세
- 작업 큐와 재개
- 내보내기

## 현재 범위에서 하지 않을 것

- Foundry 또는 Command Center를 다시 제품 본체로 삼기
- Foundry 후보 packet이나 승인 manifest 연동
- Storyyard 양방향 동기화
- 다중 저장소 권위 체계 설계
- 웹소설 집필보다 거버넌스 문서부터 확장하기
- InkOS의 Book/Chapter를 제거하고 전면 재작성하기
- 모든 부가 제작 모드를 한꺼번에 한국어화하기
- 자동 집필 daemon부터 시작하기

Storyyard가 필요해지면 나중에 완성 원고 내보내기 대상으로만 검토한다.

## 완료 기준

최소 성공 시나리오:

1. 사용자가 한국어 작품을 새로 만든다.
2. 기획서를 작성하거나 AI 도움으로 만든다.
3. 1~3화짜리 Arc를 만들고 회차별 비트를 확정한다.
4. API 키 없이 Codex ChatGPT 구독 모델을 선택한다.
5. Arc 1화 원고를 생성한다.
6. 작품 문체와 캐릭터 화법이 생성 입력에 실제로 반영된다.
7. 감리가 구조·문체·캐릭터·연속성 문제를 구분해 보여준다.
8. 사용자가 원하는 문제만 부분 수정한다.
9. 수정 전후 버전을 비교하고 복원할 수 있다.
10. 같은 Arc의 다음 회차 또는 다음 Arc로 이어간다.
11. 앱을 새로고침하거나 재시작해도 작품과 작업 이력이 남는다.
12. build, typecheck, lint, test가 통과한다.

## 새 세션의 첫 작업 지시

새 세션에는 아래 문장을 그대로 전달하면 된다.

> `/Users/a2501/Desktop/inkos/WEBNOVEL_KO_IMPLEMENTATION_CONTEXT.md`를 처음부터 끝까지 읽어라. 현재 작업 트리의 미커밋 변경은 기존 작업이므로 절대 초기화하거나 덮어쓰지 말고 먼저 diff와 테스트 상태를 확인하라. Foundry 중심 설계를 다시 제안하지 말고, InkOS를 단일 한국어 웹소설 제작기로 만드는 목표에 집중하라. 우선 기존 Codex ChatGPT 구독 연결과 부분 한국어화를 검증한 뒤, 핵심 집필 흐름의 완전 한국어화와 `Arc(1~3화)` 1급 객체 구현 계획을 세우고 실행하라. 막히지 않는 한 질문만 하고 멈추지 말고, 구현·테스트·브라우저 검증까지 진행하라.
