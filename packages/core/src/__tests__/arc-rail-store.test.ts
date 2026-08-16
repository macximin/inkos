import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnchorRailSchema,
  ArcRouteEntrySchema,
  StoryRailPlanSchema,
  type StoryRailPlan,
  type StoryRailPlanInput,
} from "../arc/rail-schema.js";
import { StoryRailStore } from "../arc/rail-store.js";

describe("StoryRailPlan", () => {
  it("allows an incremental one-anchor draft without making rails a production gate", () => {
    expect(() => StoryRailPlanSchema.parse(makePlan(makeDraftInput()))).not.toThrow();

    const input = makeDraftInput();
    input.anchorRail.status = "ready";
    expect(() => StoryRailPlanSchema.parse(makePlan(input))).toThrow(/6 to 12 anchors.*non-retired/i);
  });

  it("accepts a ready A/B rail whose active, provisional, and hypotheses reach the ending anchor", () => {
    const plan = StoryRailPlanSchema.parse(makePlan(makeReadyInput()));

    expect(plan.anchorRail.anchors).toHaveLength(6);
    expect(plan.arcRouteRail.entries.map((entry) => entry.status)).toEqual([
      "active",
      "provisional",
      "hypothesis",
      "hypothesis",
      "hypothesis",
      "hypothesis",
    ]);
  });

  it("treats ready as a route-to-ending capacity claim, including actual closed spans", () => {
    expect(() => StoryRailPlanSchema.parse(makePlan(makeReadyInput(), 19))).toThrow(
      /covers at most 18 chapters/i,
    );

    const expanded = makeReadyInput();
    expanded.arcRouteRail.entries.push(makeBEntry(7, "hypothesis", "A06"));
    expect(() => StoryRailPlanSchema.parse(makePlan(expanded, 19))).not.toThrow();

    const earlyClose = makeReadyInput();
    earlyClose.arcRouteRail.entries[0] = {
      ...earlyClose.arcRouteRail.entries[0]!,
      status: "closed",
      actualEpisodeCount: 1,
    };
    earlyClose.arcRouteRail.entries[1] = {
      ...earlyClose.arcRouteRail.entries[1]!,
      status: "active",
    };
    earlyClose.arcRouteRail.entries[2] = {
      ...earlyClose.arcRouteRail.entries[2]!,
      status: "provisional",
    };
    expect(() => StoryRailPlanSchema.parse(makePlan(earlyClose))).toThrow(
      /covers at most 16 chapters/i,
    );
    earlyClose.arcRouteRail.entries.push(makeBEntry(7, "hypothesis", "A06"));
    expect(() => StoryRailPlanSchema.parse(makePlan(earlyClose))).not.toThrow();
  });

  it("requires an actual episode count only for closed B entries", () => {
    const entry = makeReadyInput().arcRouteRail.entries[0]!;
    expect(() => ArcRouteEntrySchema.parse({ ...entry, status: "closed" })).toThrow(
      /requires its actual episode count/i,
    );
    expect(() => ArcRouteEntrySchema.parse({
      ...entry,
      status: "closed",
      actualEpisodeCount: 2,
    })).not.toThrow();
    expect(() => ArcRouteEntrySchema.parse({ ...entry, actualEpisodeCount: 2 })).toThrow(
      /only a closed/i,
    );
  });

  it("enforces the ready B lifecycle order and never routes back to an earlier Anchor", () => {
    const beforeActive = makeReadyInput();
    beforeActive.arcRouteRail.entries[0]!.status = "hypothesis";
    beforeActive.arcRouteRail.entries[1]!.status = "active";
    expect(() => StoryRailPlanSchema.parse(makePlan(beforeActive))).toThrow(
      /before the active B/i,
    );

    const afterHypothesis = makeReadyInput();
    afterHypothesis.arcRouteRail.entries[1]!.status = "hypothesis";
    afterHypothesis.arcRouteRail.entries[2]!.status = "provisional";
    expect(() => StoryRailPlanSchema.parse(makePlan(afterHypothesis))).toThrow(
      /followed only by hypotheses/i,
    );

    const routeRegression = makeReadyInput();
    routeRegression.arcRouteRail.entries[0]!.targetAnchorId = "A02";
    routeRegression.arcRouteRail.entries[1]!.targetAnchorId = "A01";
    expect(() => StoryRailPlanSchema.parse(makePlan(routeRegression))).toThrow(
      /must not route backward/i,
    );
  });

  it("keeps only the nearest planned anchors compound and permits durable-only sparse anchors", () => {
    const input = makeReadyInput();
    for (const anchor of input.anchorRail.anchors.slice(2)) {
      anchor.entryState = "";
      anchor.trigger = "";
      anchor.humanAftermath = "";
    }
    expect(() => StoryRailPlanSchema.parse(makePlan(input))).not.toThrow();

    input.anchorRail.anchors[2]!.detailLevel = "compound";
    expect(() => StoryRailPlanSchema.parse(makePlan(input))).toThrow(
      /later planned anchors must be sparse/i,
    );

    const missingDurableDirection = makeReadyInput();
    missingDurableDirection.anchorRail.anchors[2]!.irreversibleChange = "";
    expect(() => StoryRailPlanSchema.parse(makePlan(missingDurableDirection))).toThrow(
      /irreversibleChange/i,
    );
  });

  it("counts only non-retired anchors toward the ready 6-12 limit", () => {
    const anchors = makeReadyInput().anchorRail.anchors;
    anchors.push(...Array.from({ length: 7 }, (_, index) => ({
      ...makeAnchor(index + 7),
      id: `A-retired-${index + 1}`,
      state: "retired" as const,
    })));
    expect(() => AnchorRailSchema.parse({ status: "ready", anchors })).not.toThrow();

    const tooManyLive = Array.from({ length: 13 }, (_, index) => makeAnchor(index + 1));
    expect(() => AnchorRailSchema.parse({ status: "ready", anchors: tooManyLive })).toThrow(
      /6 to 12 anchors.*non-retired/i,
    );
  });

  it("rejects duplicate ids, duplicate arc bindings, non-increasing orders, and multiple active entries", () => {
    const input = makeReadyInput();
    input.anchorRail.anchors[1]!.id = input.anchorRail.anchors[0]!.id;
    input.arcRouteRail.entries[1]!.routeOrder = input.arcRouteRail.entries[0]!.routeOrder;
    input.arcRouteRail.entries[0]!.arcId = "arc-shared";
    input.arcRouteRail.entries[1]!.arcId = "arc-shared";
    input.arcRouteRail.entries[1]!.status = "active";

    expect(() => StoryRailPlanSchema.parse(makePlan(input))).toThrow(/unique|increasing|active|already bound/i);
  });

  it("rejects unknown volatile story specifics even on a hypothesis entry", () => {
    const input = makeReadyInput();
    const hypothesis = input.arcRouteRail.entries[2]! as Record<string, unknown>;
    hypothesis.exactEpisodeCoordinates = [7, 8, 9];
    hypothesis.exactReward = "황금 300개";

    expect(() => StoryRailPlanSchema.parse(makePlan(input))).toThrow(/unrecognized key/i);
    expect(() => ArcRouteEntrySchema.parse(hypothesis)).toThrow(/unrecognized key/i);
  });

  it("requires every live anchor in the route and the final live B to target the final live anchor", () => {
    const missingAnchorRoute = makeReadyInput();
    missingAnchorRoute.arcRouteRail.entries[4]!.targetAnchorId = "A04";
    expect(() => StoryRailPlanSchema.parse(makePlan(missingAnchorRoute))).toThrow(/not represented/i);

    const wrongEnding = makeReadyInput();
    wrongEnding.arcRouteRail.entries[5]!.targetAnchorId = "A05";
    expect(() => StoryRailPlanSchema.parse(makePlan(wrongEnding))).toThrow(/last live B-Rail entry/i);
  });

  it("keeps B workflow status independent from ArcPacket content status", () => {
    expect(ArcRouteEntrySchema.parse({
      ...makeReadyInput().arcRouteRail.entries[0],
      status: "active",
      arcId: "arc-draft-from-forecast",
    })).toMatchObject({ status: "active", arcId: "arc-draft-from-forecast" });
  });
});

describe("StoryRailStore", () => {
  let bookDir: string;

  beforeEach(async () => {
    bookDir = await mkdtemp(join(tmpdir(), "inkos-story-rail-"));
    await writeBookConfig(bookDir, "book-a", 18);
  });

  afterEach(async () => {
    await rm(bookDir, { recursive: true, force: true });
  });

  it("treats a missing plan as an ordinary optional state", async () => {
    const store = new StoryRailStore(bookDir);

    await expect(store.load()).resolves.toBeNull();
    await expect(store.loadOptional("book-a")).resolves.toBeNull();
  });

  it("round-trips a strict Book-local plan at story/rails/plan.json", async () => {
    const store = new StoryRailStore(bookDir, {
      now: () => new Date("2026-08-09T10:00:00.000Z"),
    });

    const saved = await store.replace("book-a", makeReadyInput());

    expect(store.planPath).toBe(join(bookDir, "story", "rails", "plan.json"));
    await expect(store.load()).resolves.toEqual(saved);
    expect(saved).toMatchObject({
      version: 1,
      bookId: "book-a",
      routeCapacity: { targetChaptersSnapshot: 18, arcEpisodeCap: 3 },
      createdAt: "2026-08-09T10:00:00.000Z",
      updatedAt: "2026-08-09T10:00:00.000Z",
    });
  });

  it("takes capacity from live book.json and leaves the file unchanged when the route is short", async () => {
    const store = new StoryRailStore(bookDir, {
      now: () => new Date("2026-08-09T10:00:00.000Z"),
    });
    const original = await store.replace("book-a", makeReadyInput());
    const before = await readFile(store.planPath, "utf8");
    await writeBookConfig(bookDir, "book-a", 19);

    await expect(store.save(original)).rejects.toThrow(/does not match live book targetChapters 19/i);
    await expect(store.replace("book-a", makeReadyInput())).rejects.toThrow(
      /covers at most 18 chapters/i,
    );
    expect(await readFile(store.planPath, "utf8")).toBe(before);

    const expanded = makeReadyInput();
    expanded.arcRouteRail.entries.push(makeBEntry(7, "hypothesis", "A06"));
    const saved = await store.replace("book-a", expanded);
    expect(saved.routeCapacity).toEqual({ targetChaptersSnapshot: 19, arcEpisodeCap: 3 });
  });

  it("fails open with one warning for corrupt optional rail data while strict load still fails", async () => {
    const warnings: string[] = [];
    const store = new StoryRailStore(bookDir);
    await mkdir(store.railsDir, { recursive: true });
    await writeFile(store.planPath, "{ definitely-not-json", "utf8");

    await expect(store.load()).rejects.toThrow(/cannot be read/i);
    await expect(store.loadOptional("book-a", (warning) => warnings.push(warning))).resolves.toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ignored");
    expect(await readFile(store.planPath, "utf8")).toBe("{ definitely-not-json");
  });

  it("ignores a foreign-book plan in optional reads and refuses to overwrite it", async () => {
    const warnings: string[] = [];
    const store = new StoryRailStore(bookDir, {
      now: () => new Date("2026-08-09T10:00:00.000Z"),
    });
    await writeBookConfig(bookDir, "book-b", 18);
    await store.replace("book-b", makeDraftInput());
    await writeBookConfig(bookDir, "book-a", 18);
    const before = await readFile(store.planPath, "utf8");

    await expect(store.loadOptional("book-a", (warning) => warnings.push(warning))).resolves.toBeNull();
    await expect(store.replace("book-a", makeDraftInput())).rejects.toThrow(/belongs to book/i);
    expect(warnings).toHaveLength(1);
    expect(await readFile(store.planPath, "utf8")).toBe(before);
  });

  it("preserves createdAt and refreshes updatedAt on replacement", async () => {
    let now = new Date("2026-08-09T10:00:00.000Z");
    const store = new StoryRailStore(bookDir, { now: () => now });
    const original = await store.replace("book-a", makeDraftInput());
    now = new Date("2026-08-09T11:00:00.000Z");

    const replaced = await store.replace("book-a", makeReadyInput());

    expect(replaced.createdAt).toBe(original.createdAt);
    expect(replaced.updatedAt).toBe("2026-08-09T11:00:00.000Z");
  });

  it("binds the active B once and returns a non-destructive conflict for another Arc", async () => {
    let now = new Date("2026-08-09T10:00:00.000Z");
    const store = new StoryRailStore(bookDir, { now: () => now });
    await store.replace("book-a", makeReadyInput());
    now = new Date("2026-08-09T11:00:00.000Z");

    const first = await store.bindActiveArc("book-a", "arc-one");
    expect(first).toMatchObject({
      status: "bound",
      changed: true,
      bId: "B001",
      arcId: "arc-one",
    });
    const afterFirstBind = await readFile(store.planPath, "utf8");

    const conflict = await store.bindActiveArc("book-a", "arc-two");
    expect(conflict).toMatchObject({
      status: "conflict",
      reason: "active_b_already_bound",
      bId: "B001",
      existingArcId: "arc-one",
      requestedArcId: "arc-two",
    });
    expect(await readFile(store.planPath, "utf8")).toBe(afterFirstBind);

    const idempotent = await store.bindActiveArc("book-a", "arc-one");
    expect(idempotent).toMatchObject({ status: "bound", changed: false });
    expect(await readFile(store.planPath, "utf8")).toBe(afterFirstBind);
  });

  it("requires explicit reflow apply for production B lifecycle changes", async () => {
    const store = new StoryRailStore(bookDir, {
      now: () => new Date("2026-08-09T10:00:00.000Z"),
    });
    await store.replace("book-a", makeReadyInput());
    await store.bindActiveArc("book-a", "arc-one");
    const initial = await store.load();
    if (!initial) throw new Error("Expected a ready Rail plan.");
    const before = await readFile(store.planPath, "utf8");

    const closedActive = clone(initial);
    closedActive.arcRouteRail.status = "draft";
    closedActive.arcRouteRail.entries[0] = {
      ...closedActive.arcRouteRail.entries[0]!,
      status: "closed",
      actualEpisodeCount: 2,
    };
    await expect(store.save(closedActive)).rejects.toThrow(/explicit reflow apply/i);

    const retiredActive = clone(initial);
    retiredActive.arcRouteRail.status = "draft";
    retiredActive.arcRouteRail.entries[0] = {
      ...retiredActive.arcRouteRail.entries[0]!,
      status: "retired",
    };
    await expect(store.save(retiredActive)).rejects.toThrow(/explicit reflow apply/i);

    const promotedProvisional = clone(initial);
    promotedProvisional.arcRouteRail.status = "draft";
    promotedProvisional.arcRouteRail.entries[0]!.status = "hypothesis";
    promotedProvisional.arcRouteRail.entries[1]!.status = "active";
    promotedProvisional.arcRouteRail.entries[2]!.status = "provisional";
    await expect(store.save(promotedProvisional)).rejects.toThrow(/explicit reflow apply/i);

    const promotedHypothesis = clone(initial);
    promotedHypothesis.arcRouteRail.status = "draft";
    promotedHypothesis.arcRouteRail.entries[1]!.status = "hypothesis";
    promotedHypothesis.arcRouteRail.entries[2]!.status = "provisional";
    await expect(store.save(promotedHypothesis)).rejects.toThrow(/explicit reflow apply/i);

    const newClosed = clone(initial);
    newClosed.arcRouteRail.status = "draft";
    newClosed.arcRouteRail.entries.push({
      ...makeBEntry(7, "hypothesis", "A06"),
      status: "closed",
      actualEpisodeCount: 1,
    });
    await expect(store.save(newClosed)).rejects.toThrow(/must begin as a hypothesis/i);

    const editedActiveContract = clone(initial);
    editedActiveContract.arcRouteRail.entries[0]!.payoffAxis = "rewritten active payoff";
    await expect(store.save(editedActiveContract)).rejects.toThrow(/durable route contract/i);

    const fakeAuthorized = clone(initial);
    fakeAuthorized.arcRouteRail.status = "draft";
    fakeAuthorized.arcRouteRail.entries[0] = {
      ...fakeAuthorized.arcRouteRail.entries[0]!,
      status: "closed",
      actualEpisodeCount: 2,
    };
    await expect(store.validateForSave(fakeAuthorized, {
      allowPendingTransitionId: "missing-pending",
    })).rejects.toThrow(/no matching pending reflow/i);
    expect(await readFile(store.planPath, "utf8")).toBe(before);

    const compatible = clone(initial);
    compatible.arcRouteRail.status = "draft";
    compatible.anchorRail.anchors[5]!.title = "revised future destination";
    compatible.arcRouteRail.entries[5]!.narrativeFunction = "revised future hypothesis";
    await expect(store.save(compatible)).resolves.toMatchObject({
      arcRouteRail: { status: "draft" },
    });
  });

  it("prevents public save and replace from dropping issued ids or changing existing Arc bindings", async () => {
    const store = new StoryRailStore(bookDir, {
      now: () => new Date("2026-08-09T10:00:00.000Z"),
    });
    const initial = await store.replace("book-a", makeProtectedDraftInput());
    const before = await readFile(store.planPath, "utf8");

    const missingAnchor = clone(initial);
    missingAnchor.anchorRail.anchors = missingAnchor.anchorRail.anchors.filter((anchor) => anchor.id !== "A02");
    await expect(store.save(missingAnchor)).rejects.toThrow(/Anchor "A02" cannot be omitted/i);

    const missingB = makeProtectedDraftInput();
    missingB.arcRouteRail.entries = missingB.arcRouteRail.entries.filter((entry) => entry.bId !== "B002");
    await expect(store.replace("book-a", missingB)).rejects.toThrow(/B-Rail id "B002" cannot be omitted/i);

    const removedBinding = clone(initial);
    delete removedBinding.arcRouteRail.entries[0]!.arcId;
    await expect(store.save(removedBinding)).rejects.toThrow(/Arc binding.*cannot be changed or removed/i);

    const changedBinding = makeProtectedDraftInput();
    changedBinding.arcRouteRail.entries[0]!.arcId = "arc-two";
    await expect(store.replace("book-a", changedBinding)).rejects.toThrow(/Arc binding.*cannot be changed or removed/i);

    expect(await readFile(store.planPath, "utf8")).toBe(before);
  });

  it("keeps retired tombstones retired and never reopens a closed B", async () => {
    const store = new StoryRailStore(bookDir, {
      now: () => new Date("2026-08-09T10:00:00.000Z"),
    });
    const input = makeProtectedDraftInput();
    input.anchorRail.anchors[1]!.state = "retired";
    input.arcRouteRail.entries[0] = {
      ...input.arcRouteRail.entries[0]!,
      status: "closed",
      actualEpisodeCount: 2,
    };
    input.arcRouteRail.entries[1]!.status = "retired";
    const initial = await store.replace("book-a", input);
    const before = await readFile(store.planPath, "utf8");

    const restoredAnchor = clone(initial);
    restoredAnchor.anchorRail.anchors[1]!.state = "planned";
    await expect(store.save(restoredAnchor)).rejects.toThrow(/Retired Anchor.*cannot be restored/i);

    const restoredB = clone(initial);
    restoredB.arcRouteRail.entries[1]!.status = "hypothesis";
    await expect(store.save(restoredB)).rejects.toThrow(/Retired B-Rail.*cannot be restored/i);

    const reopenedClosed = clone(initial);
    reopenedClosed.arcRouteRail.entries[0]!.status = "active";
    delete reopenedClosed.arcRouteRail.entries[0]!.actualEpisodeCount;
    await expect(store.save(reopenedClosed)).rejects.toThrow(/Closed B-Rail.*cannot move back/i);

    const changedActualSpan = clone(initial);
    changedActualSpan.arcRouteRail.entries[0]!.actualEpisodeCount = 3;
    await expect(store.save(changedActualSpan)).rejects.toThrow(/historical and cannot be changed/i);

    const changedClosedFunction = clone(initial);
    changedClosedFunction.arcRouteRail.entries[0]!.narrativeFunction = "rewritten history";
    await expect(store.save(changedClosedFunction)).rejects.toThrow(/historical and cannot be changed/i);

    expect(await readFile(store.planPath, "utf8")).toBe(before);
  });

  it("does not overwrite a valid plan when strict validation fails", async () => {
    const store = new StoryRailStore(bookDir, {
      now: () => new Date("2026-08-09T10:00:00.000Z"),
    });
    const plan = await store.replace("book-a", makeReadyInput());
    const before = await readFile(store.planPath, "utf8");
    const invalid = clone(plan) as StoryRailPlan & { unexpected?: string };
    invalid.unexpected = "must be rejected";

    await expect(store.save(invalid)).rejects.toThrow(/unrecognized key/i);
    expect(await readFile(store.planPath, "utf8")).toBe(before);
  });
});

function makeDraftInput(): StoryRailPlanInput {
  return {
    anchorRail: {
      status: "draft",
      anchors: [makeAnchor(1)],
    },
    arcRouteRail: {
      status: "draft",
      entries: [],
    },
  };
}

function makeProtectedDraftInput(): StoryRailPlanInput {
  return {
    anchorRail: {
      status: "draft",
      anchors: [makeAnchor(1), makeAnchor(2)],
    },
    arcRouteRail: {
      status: "draft",
      entries: [
        {
          ...makeBEntry(1, "active", "A01"),
          arcId: "arc-one",
        },
        makeBEntry(2, "hypothesis", "A01"),
      ],
    },
  };
}

function makeReadyInput(): StoryRailPlanInput {
  return {
    anchorRail: {
      status: "ready",
      anchors: Array.from({ length: 6 }, (_, index) => makeAnchor(index + 1)),
    },
    arcRouteRail: {
      status: "ready",
      entries: Array.from({ length: 6 }, (_, index) => makeBEntry(
        index + 1,
        index === 0 ? "active" : index === 1 ? "provisional" : "hypothesis",
        `A${String(index + 1).padStart(2, "0")}`,
      )),
    },
  };
}

function makeBEntry(
  index: number,
  status: "active" | "provisional" | "hypothesis",
  targetAnchorId: string,
) {
  return {
    bId: `B${String(index).padStart(3, "0")}`,
    routeOrder: index * 100,
    status,
    targetAnchorId,
    narrativeFunction: `장기 기능 ${index}`,
    payoffAxis: `보상 축 ${index}`,
    carriedReaderDebt: `독자 부채 ${index}`,
    contrastRequirement: `직전 Arc와 다른 결산 ${index}`,
  };
}

function makeAnchor(index: number) {
  return {
    id: `A${String(index).padStart(2, "0")}`,
    routeOrder: index * 100,
    title: `장기 앵커 ${index}`,
    detailLevel: index <= 2 ? "compound" as const : "sparse" as const,
    state: "planned" as const,
    entryState: `진입 상태 ${index}`,
    trigger: `트리거 ${index}`,
    irreversibleChange: `비가역 변화 ${index}`,
    humanAftermath: `인간 후폭풍 ${index}`,
    readerDebt: `독자 부채 ${index}`,
    payoffAxis: `보상 축 ${index}`,
    nextPressure: `다음 압력 ${index}`,
  };
}

function makePlan(input: StoryRailPlanInput, targetChaptersSnapshot = 18): StoryRailPlan {
  return {
    version: 1,
    bookId: "book-a",
    ...input,
    routeCapacity: { targetChaptersSnapshot, arcEpisodeCap: 3 },
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
  };
}

async function writeBookConfig(
  dir: string,
  id: string,
  targetChapters: number,
): Promise<void> {
  await writeFile(join(dir, "book.json"), `${JSON.stringify({
    id,
    title: "Rail Test Book",
    platform: "other",
    genre: "fantasy",
    status: "outlining",
    targetChapters,
    chapterWordCount: 3000,
    language: "en",
    createdAt: "2026-08-09T09:00:00.000Z",
    updatedAt: "2026-08-09T09:00:00.000Z",
  }, null, 2)}\n`, "utf8");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
