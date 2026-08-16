import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolExecution } from "../../../store/chat/types";
import { setAppLanguage } from "../../../lib/app-language";
import {
  StoryRailsPreview,
  calculateStoryRailRouteCapacity,
  getStoryRailsPreviewDetails,
} from "../StoryRailsPreview";

const anchorOne = {
  id: "A001",
  routeOrder: 10,
  title: "문이 닫히는 밤",
  detailLevel: "compound",
  state: "planned",
  entryState: "주인공이 진실을 숨기고 있다.",
  trigger: "증인이 공개 증언을 선택한다.",
  irreversibleChange: "주인공의 신원이 대중에게 공개된다.",
  humanAftermath: "가족과의 관계가 회복 불가능하게 갈라진다.",
  readerDebt: "숨겨진 이름의 대가를 지급한다.",
  payoffAxis: "정체 공개",
  nextPressure: "도시 전체가 주인공을 추적한다.",
} as const;

const anchorTwo = {
  ...anchorOne,
  id: "A002",
  routeOrder: 20,
  title: "새 도시의 주인",
  detailLevel: "sparse",
  state: "reached",
  irreversibleChange: "주인공이 도시의 통치권을 얻는다.",
} as const;

const plan = {
  version: 1,
  bookId: "demo-book",
  anchorRail: {
    status: "draft",
    anchors: [anchorTwo, anchorOne],
  },
  arcRouteRail: {
    status: "draft",
    entries: [
      {
        bId: "B000",
        routeOrder: 0,
        status: "closed",
        targetAnchorId: "A001",
        arcId: "arc-closed",
        actualEpisodeCount: 2,
        narrativeFunction: "주인공이 비밀의 존재를 알아낸다.",
        payoffAxis: "발견",
        carriedReaderDebt: "첫 단서의 의미를 밝힌다.",
        contrastRequirement: "다음 공개 Arc보다 은밀해야 한다.",
      },
      {
        bId: "B002",
        routeOrder: 20,
        status: "provisional",
        targetAnchorId: "A002",
        narrativeFunction: "권력을 얻은 뒤의 대가를 시험한다.",
        payoffAxis: "권력의 비용",
        carriedReaderDebt: "도시의 주인이 될 자격을 증명한다.",
        contrastRequirement: "공개 추격전이 아니라 조용한 정치전이어야 한다.",
      },
      {
        bId: "B001",
        routeOrder: 10,
        status: "active",
        targetAnchorId: "A001",
        arcId: "arc-live",
        narrativeFunction: "숨긴 정체를 공개할 수밖에 없게 만든다.",
        payoffAxis: "정체 공개",
        carriedReaderDebt: "독자에게 약속한 이름의 비밀을 푼다.",
        contrastRequirement: "이전 잠입 Arc보다 공개적이어야 한다.",
      },
    ],
  },
  routeCapacity: {
    targetChaptersSnapshot: 8,
    arcEpisodeCap: 3,
  },
} as const;

function execution(
  tool: "get_story_rails" | "replace_story_rails" | "apply_story_rail_reflow" | "discard_story_rail_reflow",
  details: unknown,
): ToolExecution {
  return {
    id: `${tool}-1`,
    tool,
    label: tool,
    status: "completed",
    startedAt: 1,
    completedAt: 2,
    details,
  };
}

afterEach(() => setAppLanguage("zh"));

describe("StoryRailsPreview", () => {
  it("validates the local shape and sorts anchors and B entries by route order", () => {
    const details = getStoryRailsPreviewDetails(execution("get_story_rails", {
      kind: "story_rails",
      bookId: "demo-book",
      plan,
    }));

    expect(details?.plan?.anchorRail.anchors.map((anchor) => anchor.id)).toEqual(["A001", "A002"]);
    expect(details?.plan?.arcRouteRail.entries.map((entry) => entry.bId)).toEqual(["B000", "B001", "B002"]);
    expect(details?.plan && calculateStoryRailRouteCapacity(details.plan)).toBe(8);
  });

  it("rejects malformed, mismatched and cross-reference-broken payloads", () => {
    expect(getStoryRailsPreviewDetails(execution("get_story_rails", {
      kind: "story_rails_replaced",
      bookId: "demo-book",
      plan,
    }))).toBeNull();

    expect(getStoryRailsPreviewDetails(execution("get_story_rails", {
      kind: "story_rails",
      bookId: "demo-book",
      plan: {
        ...plan,
        routeCapacity: { targetChaptersSnapshot: 8, arcEpisodeCap: 4 },
      },
    }))).toBeNull();

    expect(getStoryRailsPreviewDetails(execution("get_story_rails", {
      kind: "story_rails",
      bookId: "demo-book",
      plan: {
        ...plan,
        arcRouteRail: {
          ...plan.arcRouteRail,
          entries: [{ ...plan.arcRouteRail.entries[0], actualEpisodeCount: undefined }],
        },
      },
    }))).toBeNull();

    expect(getStoryRailsPreviewDetails(execution("get_story_rails", {
      kind: "story_rails",
      bookId: "another-book",
      plan,
    }))).toBeNull();

    expect(getStoryRailsPreviewDetails(execution("get_story_rails", {
      kind: "story_rails",
      bookId: "demo-book",
      plan: {
        ...plan,
        arcRouteRail: {
          ...plan.arcRouteRail,
          entries: [{ ...plan.arcRouteRail.entries[0], targetAnchorId: "missing-anchor" }],
        },
      },
    }))).toBeNull();
  });

  it("renders a Korean no-plan card without implying any Book to Chapter loss", () => {
    setAppLanguage("ko");
    const html = renderToStaticMarkup(React.createElement(StoryRailsPreview, {
      exec: execution("get_story_rails", {
        kind: "story_rails",
        bookId: "demo-book",
        plan: null,
      }),
    }));

    expect(html).toContain("아직 Rail 계획이 없습니다");
    expect(html).toContain("기존 Book → Chapter 집필은 그대로 작동합니다");
    expect(html).toContain("Book 정본(캐논)보다 우선순위가 낮은");
    expect(html).toContain("Arc의 하위 항목이 되지 않습니다");
  });

  it("renders ordered A/B cards, statuses, targets, bindings and warnings", () => {
    setAppLanguage("ko");
    const html = renderToStaticMarkup(React.createElement(StoryRailsPreview, {
      exec: execution("replace_story_rails", {
        kind: "story_rails_replaced",
        bookId: "demo-book",
        plan,
        binding: {
          status: "conflict",
          reason: "active_b_already_bound",
          bId: "B001",
          existingArcId: "arc-live",
          requestedArcId: "arc-new",
        },
        warnings: ["B001의 기존 Arc 연결을 유지했습니다."],
      }),
    }));

    expect(html).toContain("A-Rail · 장기 Anchor");
    expect(html).toContain("B-Rail · Arc 경로");
    expect(html.indexOf("문이 닫히는 밤")).toBeLessThan(html.indexOf("새 도시의 주인"));
    expect(html.indexOf("B001")).toBeLessThan(html.indexOf("B002"));
    expect(html).toContain("현재");
    expect(html).toContain("잠정");
    expect(html).toContain("Arc 연결 · arc-live");
    expect(html).toContain("실제 2화");
    expect(html).toContain("최대 8화 / 목표 8화");
    expect(html).toContain("목표와 정확히 일치");
    expect(html).toContain("기존 Arc 연결이 있어 덮어쓰지 않고 원래 연결을 유지했습니다");
    expect(html).toContain("B001의 기존 Arc 연결을 유지했습니다");
  });

  it("warns when a ready B-Rail maximum capacity is below its Book target snapshot", () => {
    setAppLanguage("ko");
    const html = renderToStaticMarkup(React.createElement(StoryRailsPreview, {
      exec: execution("get_story_rails", {
        kind: "story_rails",
        bookId: "demo-book",
        plan: {
          ...plan,
          anchorRail: { ...plan.anchorRail, status: "ready" },
          arcRouteRail: { ...plan.arcRouteRail, status: "ready" },
          routeCapacity: { targetChaptersSnapshot: 12, arcEpisodeCap: 3 },
        },
        warnings: ["The Rail capacity snapshot targets 12 chapters, but the Book now targets 15."],
      }),
    }));

    expect(html).toContain('data-story-rail-capacity="8/12"');
    expect(html).toContain('data-capacity-warning="true"');
    expect(html).toContain("최대 8화 / 목표 12화");
    expect(html).toContain("4화 부족");
    expect(html).toContain("최대 수용량이 Book 목표와 맞지 않습니다");
    expect(html).toContain("확인 필요");
    expect(html).toContain("The Rail capacity snapshot targets 12 chapters, but the Book now targets 15.");
  });

  it("shows a Korean pending gate and an applied reflow result without implying automatic promotion", () => {
    setAppLanguage("ko");
    const pendingHtml = renderToStaticMarkup(React.createElement(StoryRailsPreview, {
      exec: execution("get_story_rails", {
        kind: "story_rails",
        bookId: "demo-book",
        plan,
        pendingReflow: {
          pendingId: "reflow-one",
          expectedPlanUpdatedAt: "2026-08-09T10:00:00.000Z",
          activeB: { bId: "B001", arcId: "arc-live", targetAnchorId: "A001" },
          endpointChapterNumber: 3,
          actualEpisodeCount: 3,
        },
      }),
    }));

    expect(pendingHtml).toContain('data-story-rail-reflow-pending="reflow-one"');
    expect(pendingHtml).toContain("B001가 3화까지 종결 후보가 됐습니다");
    expect(pendingHtml).toContain("keep/revise/retire를 확인해 Reflow를 적용하세요");
    expect(pendingHtml).toContain("명시적으로 폐기하세요");

    const appliedHtml = renderToStaticMarkup(React.createElement(StoryRailsPreview, {
      exec: execution("apply_story_rail_reflow", {
        kind: "story_rail_reflow_applied",
        bookId: "demo-book",
        plan,
        pendingReflow: null,
        receipt: { receiptId: "reflow-one" },
      }),
    }));
    expect(appliedHtml).toContain("Reflow 적용됨");
    expect(appliedHtml).toContain('data-story-rail-fresh-arc-required="true"');
    expect(appliedHtml).toContain("최신 상태에서 새 Arc를 선택하세요");

    const discardedHtml = renderToStaticMarkup(React.createElement(StoryRailsPreview, {
      exec: execution("discard_story_rail_reflow", {
        kind: "story_rail_reflow_discarded",
        bookId: "demo-book",
        plan,
        pendingReflow: null,
        receipt: { receiptId: "reflow-one" },
      }),
    }));
    expect(discardedHtml).toContain("대기 Reflow 폐기됨");
  });
});
