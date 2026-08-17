import { describe, expect, it } from "vitest";
import { ConsolidatorAgent } from "../agents/consolidator.js";

describe("ConsolidatorAgent", () => {
  it("parses Chinese volume boundaries with full-width parentheses and chapter ranges", () => {
    const agent = new ConsolidatorAgent({
      client: {} as ConstructorParameters<typeof ConsolidatorAgent>[0]["client"],
      model: "test-model",
      projectRoot: "/tmp",
    });

    const outline = [
      "# Volume Outline",
      "",
      "### 第一卷：死而复生的实习期（1-20章）",
      "- 主角重返公司，卷入第一起异常事故",
      "",
      "### 第二卷：时间线上的猎手（21-60章）",
      "- 追查时间裂隙背后的操控者",
      "",
    ].join("\n");

    const boundaries = (agent as unknown as {
      parseVolumeBoundaries: (input: string) => Array<{ name: string; startCh: number; endCh: number }>;
    }).parseVolumeBoundaries(outline);

    expect(boundaries).toEqual([
      { name: "第一卷：死而复生的实习期", startCh: 1, endCh: 20 },
      { name: "第二卷：时间线上的猎手", startCh: 21, endCh: 60 },
    ]);
  });

  it("parses Korean volume boundaries and preserves Korean summary headers", () => {
    const agent = new ConsolidatorAgent({
      client: {} as ConstructorParameters<typeof ConsolidatorAgent>[0]["client"],
      model: "test-model",
      projectRoot: "/tmp",
    });
    const subject = agent as unknown as {
      parseVolumeBoundaries: (input: string) => Array<{ name: string; startCh: number; endCh: number }>;
      parseSummaryTable: (input: string) => { header: string; rows: Array<{ chapter: number; raw: string }> };
    };

    expect(subject.parseVolumeBoundaries([
      "### 제1권: 첫 계약 (1-10화)",
      "### 제2권: 회수국의 문 (11-20화)",
    ].join("\n"))).toEqual([
      { name: "제1권: 첫 계약", startCh: 1, endCh: 10 },
      { name: "제2권: 회수국의 문", startCh: 11, endCh: 20 },
    ]);

    const summaries = subject.parseSummaryTable([
      "| 회차 | 제목 | 주요 사건 |",
      "| --- | --- | --- |",
      "| 1 | 첫 계약 | 자동 처리 시각을 확인한다 |",
    ].join("\n"));
    expect(summaries.header).toContain("| 회차 | 제목 | 주요 사건 |");
    expect(summaries.rows).toEqual([{
      chapter: 1,
      raw: "| 1 | 첫 계약 | 자동 처리 시각을 확인한다 |",
    }]);
  });
});
