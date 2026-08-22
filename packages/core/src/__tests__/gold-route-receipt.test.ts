import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GOLD_ROUTE_RECEIPT_STORE_PATH,
  approveGoldRouteReceipt,
  inspectGoldRouteReceipt,
  loadGoldRouteReceiptStore,
} from "../references/gold-route-receipt.js";

describe("GoldRouteReceipt v1", () => {
  let projectRoot: string;
  let referenceRoot: string;
  const bookId = "gold-routing-book";
  const originPath = "analyses/doksik-chaebol3/gold_reference_card.md";
  const qaPath = "analyses/doksik-chaebol3/qa/gold-manager-receipt.json";
  const secondOriginPath = "analyses/return-ace/gold_reference_card.md";
  const secondQaPath = "analyses/return-ace/qa/gold-manager-receipt.json";

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-gold-route-project-"));
    referenceRoot = await mkdtemp(join(tmpdir(), "inkos-gold-route-reference-"));
    await Promise.all([
      mkdir(join(projectRoot, "books", bookId, "story"), { recursive: true }),
      mkdir(join(referenceRoot, "analyses", "doksik-chaebol3", "qa"), { recursive: true }),
      mkdir(join(referenceRoot, "analyses", "return-ace", "qa"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(referenceRoot, originPath), "# 독식하는 재벌 3세 Gold\n사건 E-07, 보상 R-03\n", "utf8"),
      writeFile(join(referenceRoot, qaPath), '{"strict":"PASS","managerQa":"15/15"}\n', "utf8"),
      writeFile(join(referenceRoot, secondOriginPath), "# 리턴 에이스 Gold\n경쟁 C-04, 공개 검증 P-02\n", "utf8"),
      writeFile(join(referenceRoot, secondQaPath), '{"strict":"PASS","managerQa":"15/15"}\n', "utf8"),
    ]);
  });

  afterEach(async () => {
    await Promise.all([
      rm(projectRoot, { recursive: true, force: true }),
      rm(referenceRoot, { recursive: true, force: true }),
    ]);
  });

  it("binds approved Gold evidence to selected events, rewards, and multiple production targets", async () => {
    const receipt = await createReceipt();
    expect(receipt).toMatchObject({
      version: 1,
      receiptId: "GRR-DOKSIK-001",
      bookId,
      role: "payoff",
      selectedSources: [
        { kind: "event", id: "E-07" },
        { kind: "reward", id: "R-03" },
      ],
      targets: [
        { kind: "narrative-arc", id: "NA-001" },
        { kind: "b-rail", id: "B001" },
        { kind: "arc-packet", id: "arc-001" },
      ],
    });
    expect(receipt.approval.approvedReceiptSha256).toMatch(/^[a-f0-9]{64}$/);

    const stored = await loadGoldRouteReceiptStore(projectRoot, bookId);
    expect(stored.receipts).toEqual([receipt]);
    const raw = await readFile(join(projectRoot, "books", bookId, GOLD_ROUTE_RECEIPT_STORE_PATH), "utf8");
    expect(raw).not.toContain("사건 E-07, 보상 R-03");

    const inspection = await inspectGoldRouteReceipt(receipt, {
      firefly_reference_lab: referenceRoot,
    });
    expect(inspection.status).toBe("current");
    expect(inspection.originArtifact.status).toBe("current");
    expect(inspection.qaReceiptArtifact.status).toBe("current");
  });

  it("marks changed evidence stale and absent evidence missing without mutating the receipt", async () => {
    const receipt = await createReceipt();
    await writeFile(join(referenceRoot, originPath), "# 수정된 Gold 카드\n", "utf8");
    const stale = await inspectGoldRouteReceipt(receipt, { firefly_reference_lab: referenceRoot });
    expect(stale.status).toBe("stale");
    expect(stale.originArtifact).toMatchObject({ status: "stale", reason: "hash-mismatch" });

    const missing = await inspectGoldRouteReceipt(receipt, {});
    expect(missing.status).toBe("missing");
    expect(missing.originArtifact.reason).toBe("repository-root-unavailable");
    expect((await loadGoldRouteReceiptStore(projectRoot, bookId)).receipts).toEqual([receipt]);
  });

  it("routes multiple Gold works into one target without collapsing their provenance", async () => {
    await createReceipt();
    await approveGoldRouteReceipt(projectRoot, bookId, {
      receiptId: "GRR-RETURN-ACE-001",
      originArtifact: {
        repository: "firefly_reference_lab",
        commit: "9e10a3f",
        path: secondOriginPath,
        sha256: await fileSha256(join(referenceRoot, secondOriginPath)),
      },
      qaReceiptArtifact: {
        repository: "firefly_reference_lab",
        commit: "9e10a3f",
        path: secondQaPath,
        sha256: await fileSha256(join(referenceRoot, secondQaPath)),
      },
      role: "engine",
      allowedUses: ["경쟁자의 압박과 공개 검증 순서"],
      selectedSources: [{ kind: "event", id: "C-04" }],
      forbiddenSourceSurfaces: ["원작 선수명", "원작 구단명", "경기 결과"],
      transformationRationale: "스포츠 경쟁의 압박과 공개 검증 기능을 주주총회 표 대결로 다시 설계한다.",
      targets: [{ kind: "b-rail", id: "B001" }],
      approvedBy: "owner",
    }, {
      repositoryRoots: { firefly_reference_lab: referenceRoot },
      now: () => new Date("2026-08-22T01:10:00.000Z"),
    });

    const receipts = (await loadGoldRouteReceiptStore(projectRoot, bookId)).receipts;
    expect(receipts.map((receipt) => receipt.receiptId)).toEqual([
      "GRR-DOKSIK-001",
      "GRR-RETURN-ACE-001",
    ]);
    expect(receipts.every((receipt) => receipt.targets.some((target) => target.id === "B001"))).toBe(true);
    expect(new Set(receipts.map((receipt) => receipt.originArtifact.path)).size).toBe(2);
  });

  it("rejects an approval receipt changed after human approval", async () => {
    const receipt = await createReceipt();
    const storePath = join(projectRoot, "books", bookId, GOLD_ROUTE_RECEIPT_STORE_PATH);
    const store = JSON.parse(await readFile(storePath, "utf8")) as {
      receipts: Array<{ transformationRationale: string }>;
    };
    store.receipts[0]!.transformationRationale = "승인 뒤 몰래 바꾼 변환 근거로 충분히 긴 문장이다.";
    await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await expect(loadGoldRouteReceiptStore(projectRoot, bookId)).rejects.toThrow(/approval hash mismatch/i);
  });

  it("refuses approval when Gold or QA evidence is not current", async () => {
    const originSha256 = await fileSha256(join(referenceRoot, originPath));
    await writeFile(join(referenceRoot, originPath), "# 승인 직전 바뀐 Gold 카드\n", "utf8");
    await expect(approveGoldRouteReceipt(projectRoot, bookId, {
      receiptId: "GRR-STALE-001",
      originArtifact: {
        repository: "firefly_reference_lab",
        commit: "4176212",
        path: originPath,
        sha256: originSha256,
      },
      qaReceiptArtifact: {
        repository: "firefly_reference_lab",
        commit: "4176212",
        path: qaPath,
        sha256: await fileSha256(join(referenceRoot, qaPath)),
      },
      role: "engine",
      allowedUses: ["사건 압력"],
      selectedSources: [{ kind: "event", id: "E-07" }],
      forbiddenSourceSurfaces: ["원작 인물명"],
      transformationRationale: "사건 기능만 새 작품의 업종과 인물 관계에 맞춰 다시 설계한다.",
      targets: [{ kind: "arc-packet", id: "arc-001" }],
      approvedBy: "owner",
    }, {
      repositoryRoots: { firefly_reference_lab: referenceRoot },
    })).rejects.toThrow(/source evidence is stale/i);
    expect((await loadGoldRouteReceiptStore(projectRoot, bookId)).receipts).toEqual([]);
  });

  it("preserves createdAt while reapproval replaces one stable receipt id", async () => {
    const first = await createReceipt("2026-08-22T01:00:00.000Z");
    const second = await createReceipt("2026-08-22T02:00:00.000Z", "hook");
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe("2026-08-22T02:00:00.000Z");
    expect(second.role).toBe("hook");
    expect((await loadGoldRouteReceiptStore(projectRoot, bookId)).receipts).toHaveLength(1);
  });

  async function createReceipt(
    now = "2026-08-22T01:00:00.000Z",
    role: "payoff" | "hook" = "payoff",
  ) {
    return approveGoldRouteReceipt(projectRoot, bookId, {
      receiptId: "GRR-DOKSIK-001",
      originArtifact: {
        repository: "firefly_reference_lab",
        commit: "4176212",
        path: originPath,
        sha256: await fileSha256(join(referenceRoot, originPath)),
      },
      qaReceiptArtifact: {
        repository: "firefly_reference_lab",
        commit: "4176212",
        path: qaPath,
        sha256: await fileSha256(join(referenceRoot, qaPath)),
      },
      role,
      allowedUses: ["재벌물 사업 승부의 사건 순서", "독자가 체감하는 지위 보상"],
      selectedSources: [
        { kind: "event", id: "E-07" },
        { kind: "reward", id: "R-03" },
      ],
      forbiddenSourceSurfaces: ["원작 인물명", "원작 기업명", "원문 문장"],
      transformationRationale: "반도체 인수전을 조선업 공급망 확보전으로 바꾸고 보상의 기능만 유지한다.",
      targets: [
        { kind: "narrative-arc", id: "NA-001" },
        { kind: "b-rail", id: "B001" },
        { kind: "arc-packet", id: "arc-001" },
      ],
      approvedBy: "owner",
    }, {
      now: () => new Date(now),
      repositoryRoots: { firefly_reference_lab: referenceRoot },
    });
  }
});

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
