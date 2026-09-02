import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_MANIFEST_BYTES = 512 * 1024;

export const TRUSTED_ADOPTION_REPOSITORIES = {
  referenceLab: {
    origin: "git@github.com:macximin/firefly_reference_lab.git",
    branch: "main",
  },
  inkos: {
    origin: "git@github.com:macximin/inkos.git",
    branch: "master",
  },
  hq: {
    origin: "git@github.com:macximin/firefly_studio.git",
    branch: "main",
  },
} as const;

export interface SoulEvidenceRoots {
  readonly referenceLab: string;
  readonly inkos: string;
  readonly hq?: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function safeRelativePath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) {
    throw new Error("Firefly HQ edge repository path is unsafe.");
  }
  return value;
}

function gitText(repoRoot: string, args: readonly string[], label: string): Promise<string> {
  return new Promise((resolveText, reject) => {
    execFile(
      "git",
      ["--no-replace-objects", "-C", repoRoot, ...args],
      { encoding: "utf8", maxBuffer: MAX_MANIFEST_BYTES },
      (error, stdout) => {
        if (error) {
          reject(new Error(`${label} Git topology could not be verified.`, { cause: error }));
          return;
        }
        resolveText(stdout.trim());
      },
    );
  });
}

function gitBlob(repoRoot: string, commit: string, path: string, label: string): Promise<Buffer> {
  return new Promise((resolveBytes, reject) => {
    execFile(
      "git",
      ["--no-replace-objects", "-C", repoRoot, "show", `${commit}:${path}`],
      { encoding: "buffer", maxBuffer: MAX_MANIFEST_BYTES },
      (error, stdout) => {
        if (error) {
          reject(new Error(`${label} is not readable from declared Git commit ${commit}.`, { cause: error }));
          return;
        }
        resolveBytes(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

async function exactGitTopLevel(path: string, label: string): Promise<string> {
  const [claimed, topLevel] = await Promise.all([
    realpath(path),
    gitText(path, ["rev-parse", "--show-toplevel"], label),
  ]);
  const canonicalTopLevel = await realpath(topLevel);
  if (claimed !== canonicalTopLevel) throw new Error(`${label} root is not the exact Git top-level.`);
  return canonicalTopLevel;
}

async function containingGitTopLevel(path: string, label: string): Promise<string> {
  return realpath(await gitText(path, ["rev-parse", "--show-toplevel"], label));
}

/**
 * Anchors adoption evidence to the checkout that loaded this InkOS runtime and
 * to the HQ topology declared in the claimed, remotely reachable HQ commit.
 * This function intentionally has no caller-controlled bypass. Unit tests mock
 * this module rather than weakening the production input contract.
 */
export async function assertCanonicalEvidenceTopology(input: {
  readonly hqCommit: string;
  readonly evidenceRoots?: SoulEvidenceRoots;
}): Promise<void> {
  const roots = input.evidenceRoots;
  if (!roots?.hq || !roots.inkos || !roots.referenceLab) {
    throw new Error("Genre Soul adoption requires canonical HQ, InkOS, and Reference Lab roots.");
  }
  const loadedInkOSRoot = await containingGitTopLevel(
    dirname(fileURLToPath(import.meta.url)),
    "Loaded InkOS module",
  );
  const inkosRoot = await exactGitTopLevel(roots.inkos, "InkOS evidence");
  if (inkosRoot !== loadedInkOSRoot) {
    throw new Error("InkOS evidence root is not the repository that loaded this InkOS runtime.");
  }
  const familyHqRoot = await exactGitTopLevel(resolve(loadedInkOSRoot, "..", ".."), "Firefly HQ evidence");
  const hqRoot = await exactGitTopLevel(roots.hq, "Firefly HQ evidence");
  if (hqRoot !== familyHqRoot) {
    throw new Error("Firefly HQ evidence root is not the loaded InkOS repository family root.");
  }

  const manifestBytes = await gitBlob(
    hqRoot,
    input.hqCommit,
    "config/edge-repos.json",
    "Firefly HQ edge repository manifest",
  );
  let manifest: Record<string, unknown>;
  try {
    manifest = object(JSON.parse(manifestBytes.toString("utf8")), "Firefly HQ edge repository manifest");
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Firefly HQ edge repository manifest is not valid JSON.", { cause: error });
    }
    throw error;
  }
  const policy = object(manifest.policy, "Firefly HQ edge repository manifest policy");
  if (
    manifest.schemaVersion !== 2
    || manifest.family !== "firefly-studio"
    || policy.manifestIsScopeAuthority !== true
    || policy.defaultProductionEngine !== "inkos"
    || !Array.isArray(manifest.repos)
  ) {
    throw new Error("Firefly HQ edge repository manifest authority drifted.");
  }
  const entries = new Map<string, Record<string, unknown>>();
  for (const value of manifest.repos) {
    const entry = object(value, "Firefly HQ edge repository entry");
    if (typeof entry.name !== "string" || entries.has(entry.name)) {
      throw new Error("Firefly HQ edge repository manifest has an invalid or duplicate repository name.");
    }
    entries.set(entry.name, entry);
  }
  const expectedEntries = [
    ["inkos", inkosRoot, TRUSTED_ADOPTION_REPOSITORIES.inkos],
    [
      "firefly_reference_lab",
      await exactGitTopLevel(roots.referenceLab, "Reference Lab evidence"),
      TRUSTED_ADOPTION_REPOSITORIES.referenceLab,
    ],
  ] as const;
  for (const [name, actualRoot, authority] of expectedEntries) {
    const entry = entries.get(name);
    if (!entry || typeof entry.path !== "string") {
      throw new Error(`Firefly HQ manifest is missing ${name}.`);
    }
    const manifestRoot = await realpath(resolve(hqRoot, safeRelativePath(entry.path)));
    if (
      manifestRoot !== actualRoot
      || entry.remoteUrl !== authority.origin
      || entry.branch !== authority.branch
    ) {
      throw new Error(`Firefly HQ manifest ${name} topology/authority drifted.`);
    }
  }
}
