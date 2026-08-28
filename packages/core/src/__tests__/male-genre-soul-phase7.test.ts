import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readGenreProfile, readGenreProfileWithReceipt } from "../agents/rules-reader.js";
import {
  assertCurrentProductionGenreProfileReceipt,
  createProductionInputReceipt,
  runWithProductionInputBundle,
  sha256Bytes,
} from "../production/production-input.js";
import { SoulPackageManifestSchema } from "../production/soul-schema.js";

const roots: string[] = [];
const coreRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const genresRoot = join(coreRoot, "genres");
const soulsRoot = join(coreRoot, "souls");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Phase 7 male genre profiles and candidate Souls", () => {
  it("resolves explicit Korean aliases without stealing the specialized chaebol route", async () => {
    const cases = [
      ["현대판타지", "modern-fantasy-ko"],
      ["현대 판타지", "modern-fantasy-ko"],
      ["현판", "modern-fantasy-ko"],
      ["판타지", "fantasy-ko"],
      ["정통 판타지", "fantasy-ko"],
      ["무협", "murim-ko"],
      ["무협물", "murim-ko"],
      ["현대판타지 재벌물", "chaebol-modern-fantasy-ko"],
    ] as const;
    for (const [requested, expected] of cases) {
      const resolved = await readGenreProfileWithReceipt("/tmp/inkos-no-project-profile", requested);
      expect(resolved.profile.id).toBe(expected);
      expect(resolved.profile.language).toBe("ko");
      expect(resolved.receipt).toMatchObject({
        schemaVersion: "genre-profile-read-receipt/v1",
        requestedGenre: requested,
        resolvedProfileId: expected,
        source: "builtin",
        profilePath: `builtin-genres/${expected}.md`,
        language: "ko",
      });
      const bytes = await readFile(join(genresRoot, `${expected}.md`));
      expect(resolved.receipt.profileSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(resolved.receipt.profileSizeBytes).toBe(bytes.byteLength);
    }
  });

  it("keeps all three profiles commercial-first, content-neutral, and quota-free", async () => {
    for (const id of ["modern-fantasy-ko", "fantasy-ko", "murim-ko"] as const) {
      const resolved = await readGenreProfile("/tmp/inkos-no-project-profile", id);
      const text = `${resolved.profile.pacingRule}\n${resolved.body}`;
      expect(resolved.profile.id).toBe(id);
      expect(resolved.profile.satisfactionTypes.length).toBeGreaterThanOrEqual(6);
      expect(text).toMatch(/주인공|지급|보상/u);
      expect(text).toMatch(/유능|대응/u);
      expect(text).toMatch(/불법|범죄|암살/u);
      expect(text).toMatch(/도덕|처벌|응보/u);
      expect(text).not.toMatch(/(?:불법|범죄)(?:을|를).{0,8}(?:금지한다|자동 거절한다|감점한다)/u);
      expect(text).not.toMatch(/(?:반성|사과|갱생|속죄|응보|처벌)(?:을|를).{0,8}(?:반드시 해야 한다|필수다|의무화한다)/u);
      expect(text).not.toMatch(/(?:매 장면|매 회차|\d+화마다).{0,16}(?:반드시|필수)/u);
      expect(text).not.toMatch(/[\u3400-\u9fff]/u);
    }
  });

  it("ships three self-contained candidate packages without claiming promotion", async () => {
    const cases = [
      ["male-modern-fantasy-ko", "modern-fantasy-ko"],
      ["male-fantasy-ko", "fantasy-ko"],
      ["male-murim-ko", "murim-ko"],
    ] as const;
    for (const [soulId, profileId] of cases) {
      const root = join(soulsRoot, soulId, "v1");
      const manifest = SoulPackageManifestSchema.parse(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")));
      const soul = await readFile(join(root, manifest.promptPath), "utf8");
      const resource = await readFile(join(root, manifest.resources[0]!), "utf8");
      expect(manifest).toEqual({
        schemaVersion: "soul-package/v1",
        soulId,
        version: "v1",
        promptPath: "SOUL.md",
        resources: ["resources/genre.md"],
      });
      expect(soul).toContain("Lifecycle: candidate-only");
      expect(soul).toContain(`Writer genre profile: \`${profileId}\``);
      expect(soul).not.toMatch(/(?:Model|Reasoning):/u);
      expect(soul).toContain("promoted로 사용할 수 없다");
      expect(soul).toContain("표면 겹침은 HIL 비교 정보");
      expect(resource).toContain("candidate-only");
      expect(`${soul}\n${resource}`).not.toMatch(/(?:불법|범죄)(?:을|를).{0,8}(?:금지한다|자동 거절한다|감점한다)/u);
    }
  });

  it("fails closed on project profile ID drift and symlinks while traversal-like labels fall back safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-genre-profile-"));
    roots.push(root);
    await mkdir(join(root, "genres"), { recursive: true });
    await writeFile(join(root, "genres", "modern-fantasy-ko.md"), `---
name: 잘못된 프로필
id: other-ko
language: ko
chapterTypes: ["진입"]
fatigueWords: []
---
본문
`);
    await expect(readGenreProfileWithReceipt(root, "modern-fantasy-ko")).rejects.toThrow(/ID drift/u);

    await rm(join(root, "genres", "modern-fantasy-ko.md"));
    await symlink(join(genresRoot, "modern-fantasy-ko.md"), join(root, "genres", "modern-fantasy-ko.md"));
    await expect(readGenreProfileWithReceipt(root, "modern-fantasy-ko")).rejects.toThrow(/real regular file/u);

    const traversal = await readGenreProfileWithReceipt(root, "../../outside");
    expect(traversal.profile.id).toBe("other");
    expect(traversal.receipt.resolvedProfileId).toBe("other");

    const externalGenres = await mkdtemp(join(tmpdir(), "inkos-external-genres-"));
    roots.push(externalGenres);
    await writeFile(join(externalGenres, "modern-fantasy-ko.md"), await readFile(join(genresRoot, "modern-fantasy-ko.md")));
    await rm(join(root, "genres"), { recursive: true });
    await symlink(externalGenres, join(root, "genres"));
    await expect(readGenreProfileWithReceipt(root, "modern-fantasy-ko")).rejects.toThrow(/parent must be a real directory/u);
  });

  it("binds the exact Writer-loaded profile bytes to a kernel production receipt", async () => {
    const resolved = await readGenreProfileWithReceipt("/tmp/inkos-no-project-profile", "현대판타지");
    const receipt = createProductionInputReceipt({
      schemaVersion: "production-input-receipt/v1",
      soul: null,
      skills: [],
      writerGenreProfile: resolved.receipt,
      externalContextSha256: sha256Bytes(""),
      promptInjectionSha256: sha256Bytes(""),
    });
    const productionOperationId = randomUUID();
    const attemptId = randomUUID();
    runWithProductionInputBundle({
      bookId: "phase7-profile-binding",
      commandId: randomUUID(),
      productionOperationId,
      attemptId,
      promptInjection: "",
      externalContextText: "",
      receipt,
    }, () => assertCurrentProductionGenreProfileReceipt(resolved.receipt));
    expect(() => runWithProductionInputBundle({
      bookId: "phase7-profile-binding",
      commandId: randomUUID(),
      productionOperationId,
      attemptId,
      promptInjection: "",
      externalContextText: "",
      receipt,
    }, () => assertCurrentProductionGenreProfileReceipt({
      ...resolved.receipt,
      profileSha256: "0".repeat(64),
    }))).toThrow(/profile bytes do not match/u);
  });
});
