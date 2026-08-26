import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  loadConfiguredAgentSkills,
  loadExternalAgentSkills,
  type ExternalSkillDiagnostic,
  type LoadConfiguredAgentSkillsInput,
} from "./external-loader.js";
import type { AgentSkill } from "./types.js";

export interface LoadAvailableAgentSkillsResult {
  readonly skills: ReadonlyArray<AgentSkill>;
  readonly diagnostics: ReadonlyArray<ExternalSkillDiagnostic>;
}

export async function loadBuiltinAgentSkills(
  builtinRoot = builtinSkillsRoot(),
): Promise<LoadAvailableAgentSkillsResult> {
  return loadExternalAgentSkills({
    externalDirs: [builtinRoot],
    source: "builtin",
  });
}

export async function loadAvailableAgentSkills(
  input: LoadConfiguredAgentSkillsInput,
): Promise<LoadAvailableAgentSkillsResult> {
  const [builtin, configured] = await Promise.all([
    loadBuiltinAgentSkills(),
    loadConfiguredAgentSkills(input),
  ]);
  return {
    // Registry de-duplication is last-write-wins, so project/user skills can
    // intentionally replace an InkOS default with the same AgentSkills id.
    skills: [...builtin.skills, ...configured.skills],
    diagnostics: [...builtin.diagnostics, ...configured.diagnostics],
  };
}

export async function loadBuiltinSkillResource(skillId: string, resourcePath: string): Promise<string> {
  const loaded = await loadBuiltinAgentSkills();
  const skill = loaded.skills.find((candidate) => candidate.id === skillId);
  if (!skill?.baseDir) throw new Error(`Built-in skill is unavailable: ${skillId}`);
  const fullPath = join(skill.baseDir, resourcePath);
  const rel = relative(skill.baseDir, fullPath);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`Built-in skill resource path is unsafe: ${resourcePath}`);
  }
  return readFile(fullPath, "utf8");
}

function builtinSkillsRoot(): string {
  return fileURLToPath(new URL("../../skills", import.meta.url));
}
