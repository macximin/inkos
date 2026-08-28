import { delimiter } from "node:path";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WRITE_NEXT_PRODUCTION_SKILL_POLICY,
  resolveWriteNextProductionSkills,
} from "../production/production-skill.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function rootFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inkos-phase4-skill-"));
  roots.push(root);
  return root;
}

async function writeSkill(root: string, name: string, body: string): Promise<string> {
  const skillRoot = join(root, name);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${name} test skill`,
    "---",
    body,
    "",
  ].join("\n"), "utf8");
  return skillRoot;
}

describe("Phase 4 production Skill resolver", () => {
  it("resolves the pinned required builtin into an exact input receipt", async () => {
    const root = await rootFixture();
    const resolved = await resolveWriteNextProductionSkills({
      projectRoot: root,
      env: {},
      homeDir: join(root, "home"),
    });
    expect(resolved.receipts).toHaveLength(1);
    expect(resolved.receipts[0]).toMatchObject({
      id: "inkos-long-writing",
      namespace: "trusted-builtin",
      manifestSha256: WRITE_NEXT_PRODUCTION_SKILL_POLICY.required[0]!.manifestSha256,
    });
    expect(resolved.receipts[0]!.resources).toEqual([
      expect.objectContaining({ path: "references/collaboration-protocol.md" }),
    ]);
    expect(resolved.promptInputs[0]).toContain("Surface overlap inside an authorized binding");
  });

  it("fails closed when the required Skill is disabled, missing, or hash-drifted", async () => {
    const root = await rootFixture();
    await expect(resolveWriteNextProductionSkills({
      projectRoot: root,
      disabledSkillIds: ["inkos-long-writing"],
      env: {},
      homeDir: join(root, "home"),
    })).rejects.toThrow(/cannot be disabled/i);

    const emptyBuiltin = join(root, "empty-builtin");
    await mkdir(emptyBuiltin, { recursive: true });
    await expect(resolveWriteNextProductionSkills({
      projectRoot: root,
      builtinRoot: emptyBuiltin,
      env: {},
      homeDir: join(root, "home"),
    })).rejects.toThrow();

    const driftedBuiltin = join(root, "drifted-builtin");
    await writeSkill(driftedBuiltin, "inkos-long-writing", "tampered body");
    await expect(resolveWriteNextProductionSkills({
      projectRoot: root,
      builtinRoot: driftedBuiltin,
      env: {},
      homeDir: join(root, "home"),
    })).rejects.toThrow(/manifest hash mismatch/i);
  });

  it("separates owner overlays and rejects required shadowing or last-write-wins conflicts", async () => {
    const root = await rootFixture();
    const shadow = await writeSkill(join(root, "shadow"), "inkos-long-writing", "shadow");
    await expect(resolveWriteNextProductionSkills({
      projectRoot: root,
      env: { INKOS_SKILL_DIRS: shadow },
      homeDir: join(root, "home"),
    })).rejects.toThrow(/cannot shadow/i);

    const first = await writeSkill(join(root, "first"), "owner-commercial", "first bytes");
    const second = await writeSkill(join(root, "second"), "owner-commercial", "different bytes");
    await expect(resolveWriteNextProductionSkills({
      projectRoot: root,
      requestedSkillIds: ["owner-commercial"],
      env: { INKOS_SKILL_DIRS: [first, second].join(delimiter) },
      homeDir: join(root, "home"),
    })).rejects.toThrow(/last-write-wins is forbidden/i);
  });

  it("rejects symlink, NUL, extension, and missing requested overlay packages", async () => {
    const root = await rootFixture();
    const skill = await writeSkill(join(root, "link"), "owner-link", "load refs.md");
    const outside = join(root, "outside.md");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, join(skill, "refs.md"));
    await expect(resolveWriteNextProductionSkills({
      projectRoot: root,
      requestedSkillIds: ["owner-link"],
      env: { INKOS_SKILL_DIRS: skill },
      homeDir: join(root, "home"),
    })).rejects.toThrow(/symlink/i);

    const nul = await writeSkill(join(root, "nul"), "owner-nul", "valid body");
    await writeFile(join(nul, "bad.txt"), Buffer.from([65, 0, 66]));
    await expect(resolveWriteNextProductionSkills({
      projectRoot: root,
      requestedSkillIds: ["owner-nul"],
      env: { INKOS_SKILL_DIRS: nul },
      homeDir: join(root, "home"),
    })).rejects.toThrow(/NUL/i);

    const extension = await writeSkill(join(root, "extension"), "owner-extension", "valid body");
    await writeFile(join(extension, "payload.bin"), "bytes", "utf8");
    await expect(resolveWriteNextProductionSkills({
      projectRoot: root,
      requestedSkillIds: ["owner-extension"],
      env: { INKOS_SKILL_DIRS: extension },
      homeDir: join(root, "home"),
    })).rejects.toThrow(/extension/i);

    const oversized = await writeSkill(join(root, "oversized"), "owner-oversized", "valid body");
    await writeFile(join(oversized, "too-large.txt"), Buffer.alloc(512 * 1024 + 1, 65));
    await expect(resolveWriteNextProductionSkills({
      projectRoot: root,
      requestedSkillIds: ["owner-oversized"],
      env: { INKOS_SKILL_DIRS: oversized },
      homeDir: join(root, "home"),
    })).rejects.toThrow(/exceeds/i);

    await expect(resolveWriteNextProductionSkills({
      projectRoot: root,
      requestedSkillIds: ["does-not-exist"],
      env: {},
      homeDir: join(root, "home"),
    })).rejects.toThrow(/missing/i);
  });
});
