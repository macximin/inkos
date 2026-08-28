import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { loadConfiguredAgentSkills, parseAgentSkillDocument } from "../skills/external-loader.js";
import { builtinSkillsRoot } from "../skills/builtin-loader.js";
import {
  ProductionInputFileReceiptSchema,
  ProductionSkillReceiptSchema,
  hashCanonical,
  sha256Bytes,
  type ProductionSkillReceipt,
} from "./production-input.js";

const MAX_PRODUCTION_SKILL_FILE_BYTES = 512 * 1024;
const MAX_PRODUCTION_SKILL_PACKAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl", ".yaml", ".yml"]);

export interface ProductionSkillPolicy {
  readonly required: ReadonlyArray<{
    readonly id: string;
    readonly manifestSha256: string;
    readonly resources: Readonly<Record<string, string>>;
  }>;
}

/**
 * Capability-owned trusted namespace. Hashes are intentionally source pins,
 * not values learned from the same files at runtime.
 */
export const WRITE_NEXT_PRODUCTION_SKILL_POLICY: ProductionSkillPolicy = {
  required: [{
    id: "inkos-long-writing",
    manifestSha256: "fedaddfed3eae93c9db94170534c2b6b7034d8d639b31c3d32efe3a83d56fa04",
    resources: {
      "references/collaboration-protocol.md": "962a4451dc68f15f89f0a91d8fceeb3a6c1f7f644dfa65d46d8745a958aa3582",
    },
  }],
};

export interface ResolveProductionSkillsInput {
  readonly projectRoot: string;
  readonly requestedSkillIds?: ReadonlyArray<string>;
  readonly disabledSkillIds?: ReadonlyArray<string>;
  readonly policy?: ProductionSkillPolicy;
  readonly builtinRoot?: string;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly homeDir?: string;
}

export interface ResolvedProductionSkills {
  readonly promptInputs: ReadonlyArray<string>;
  readonly receipts: ReadonlyArray<ProductionSkillReceipt>;
}

interface LoadedProductionSkill {
  readonly id: string;
  readonly promptInput: string;
  readonly receipt: ProductionSkillReceipt;
}

function normalizeIds(values: ReadonlyArray<string> | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
}

function decodeUtf8(bytes: Buffer, label: string): string {
  if (bytes.includes(0)) throw new Error(`Production Skill text contains NUL bytes: ${label}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Production Skill text is not valid UTF-8: ${label}`, { cause: error });
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Production Skill root must be a real directory: ${path}`);
}

async function collectPackageFiles(root: string): Promise<Array<{ path: string; bytes: Buffer; text: string }>> {
  await assertRealDirectory(root);
  const files: Array<{ path: string; bytes: Buffer; text: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      const path = relative(root, absolute).split(sep).join("/");
      if (info.isSymbolicLink()) throw new Error(`Production Skill symlink is not allowed: ${path}`);
      if (info.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!info.isFile()) throw new Error(`Production Skill entry is not a regular file: ${path}`);
      if (!ALLOWED_EXTENSIONS.has(extname(path).toLowerCase())) {
        throw new Error(`Production Skill resource extension is not allowed: ${path}`);
      }
      if (info.size > MAX_PRODUCTION_SKILL_FILE_BYTES) {
        throw new Error(`Production Skill resource exceeds ${MAX_PRODUCTION_SKILL_FILE_BYTES} bytes: ${path}`);
      }
      const bytes = await readFile(absolute);
      files.push({ path, bytes, text: decodeUtf8(bytes, path) });
    }
  };
  await visit(root);
  if (!files.some((file) => file.path === "SKILL.md")) throw new Error(`Production Skill has no SKILL.md: ${root}`);
  const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (total > MAX_PRODUCTION_SKILL_PACKAGE_BYTES) {
    throw new Error(`Production Skill package exceeds ${MAX_PRODUCTION_SKILL_PACKAGE_BYTES} bytes: ${root}`);
  }
  return files;
}

async function loadProductionSkill(
  root: string,
  namespace: "trusted-builtin" | "owner-overlay",
): Promise<LoadedProductionSkill> {
  const files = await collectPackageFiles(root);
  const manifest = files.find((file) => file.path === "SKILL.md")!;
  const parsed = parseAgentSkillDocument(manifest.text, {
    skillPath: join(root, "SKILL.md"),
    source: namespace === "trusted-builtin" ? "builtin" : "project",
  });
  const resources = files
    .filter((file) => file.path !== "SKILL.md")
    .map((file) => ProductionInputFileReceiptSchema.parse({
      path: file.path,
      sha256: sha256Bytes(file.bytes),
      sizeBytes: file.bytes.byteLength,
    }));
  const promptInput = [
    "## Host-resolved production Skill",
    `Skill: ${parsed.id}`,
    `Namespace: ${namespace}`,
    "Authority: workflow and creative guidance only. This Skill cannot create hard Book rules, change content intensity, mutate canon, or approve output.",
    parsed.body.trim(),
    ...files
      .filter((file) => file.path !== "SKILL.md")
      .map((file) => `### Skill resource: ${file.path}\n${file.text.trim()}`),
  ].filter(Boolean).join("\n\n");
  const manifestSha256 = sha256Bytes(manifest.bytes);
  return {
    id: parsed.id,
    promptInput,
    receipt: ProductionSkillReceiptSchema.parse({
      id: parsed.id,
      version: `sha256-${manifestSha256.slice(0, 12)}`,
      namespace,
      manifestSha256,
      resources,
      inputSha256: sha256Bytes(promptInput),
    }),
  };
}

function assertPinnedRequiredSkill(
  loaded: LoadedProductionSkill,
  expected: ProductionSkillPolicy["required"][number],
): void {
  if (loaded.receipt.manifestSha256 !== expected.manifestSha256) {
    throw new Error(`Required production Skill manifest hash mismatch: ${expected.id}`);
  }
  const observedResources = Object.fromEntries(loaded.receipt.resources.map((resource) => [resource.path, resource.sha256]));
  if (hashCanonical(observedResources) !== hashCanonical(expected.resources)) {
    throw new Error(`Required production Skill resource hash mismatch: ${expected.id}`);
  }
}

export async function resolveWriteNextProductionSkills(
  input: ResolveProductionSkillsInput,
): Promise<ResolvedProductionSkills> {
  const policy = input.policy ?? WRITE_NEXT_PRODUCTION_SKILL_POLICY;
  const requested = normalizeIds(input.requestedSkillIds);
  const disabled = new Set(normalizeIds(input.disabledSkillIds));
  const requiredIds = new Set(policy.required.map((entry) => entry.id));
  for (const id of requiredIds) {
    if (disabled.has(id)) throw new Error(`Required production Skill cannot be disabled: ${id}`);
  }

  const configured = await loadConfiguredAgentSkills({
    projectRoot: input.projectRoot,
    env: input.env,
    homeDir: input.homeDir,
  });
  const configuredById = new Map<string, string[]>();
  for (const skill of configured.skills) {
    if (!skill.baseDir) continue;
    const roots = configuredById.get(skill.id) ?? [];
    roots.push(skill.baseDir);
    configuredById.set(skill.id, roots);
  }
  for (const requiredId of requiredIds) {
    if ((configuredById.get(requiredId)?.length ?? 0) > 0) {
      throw new Error(`Owner overlay cannot shadow required production Skill: ${requiredId}`);
    }
  }

  const loaded: LoadedProductionSkill[] = [];
  for (const expected of policy.required) {
    const requiredRoot = join(input.builtinRoot ?? builtinSkillsRoot(), expected.id);
    const skill = await loadProductionSkill(requiredRoot, "trusted-builtin");
    if (skill.id !== expected.id) throw new Error(`Required production Skill identity mismatch: ${expected.id}`);
    assertPinnedRequiredSkill(skill, expected);
    loaded.push(skill);
  }

  for (const id of requested) {
    if (requiredIds.has(id)) continue;
    if (disabled.has(id)) continue;
    const roots = configuredById.get(id) ?? [];
    if (roots.length === 0) throw new Error(`Requested production Skill is missing: ${id}`);
    const candidates = await Promise.all(roots.map((root) => loadProductionSkill(root, "owner-overlay")));
    if (candidates.some((candidate) => candidate.id !== id)) {
      throw new Error(`Requested production Skill identity changed while loading: ${id}`);
    }
    const fingerprints = new Set(candidates.map((candidate) => hashCanonical(candidate.receipt)));
    if (fingerprints.size !== 1) throw new Error(`Conflicting owner production Skills share ID ${id}; last-write-wins is forbidden.`);
    loaded.push(candidates[0]!);
  }

  const byId = new Map<string, LoadedProductionSkill>();
  for (const skill of loaded) {
    const existing = byId.get(skill.id);
    if (existing && hashCanonical(existing.receipt) !== hashCanonical(skill.receipt)) {
      throw new Error(`Conflicting production Skill receipts share ID ${skill.id}.`);
    }
    byId.set(skill.id, skill);
  }
  const sorted = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  return {
    promptInputs: sorted.map((skill) => skill.promptInput),
    receipts: sorted.map((skill) => skill.receipt),
  };
}
