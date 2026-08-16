import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export function safeChildPath(root: string, requestedPath: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, requestedPath);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return resolvedPath;
  }
  throw new Error(`Path traversal blocked: ${requestedPath}`);
}

/**
 * Resolve a child path while rejecting an authority root or any existing path
 * component implemented as a symbolic link. Missing tail components are
 * allowed so callers can safely create a new directory/file after validation.
 */
export async function safeNonSymlinkChildPath(root: string, requestedPath: string): Promise<string> {
  const resolvedRoot = resolve(root);
  const target = safeChildPath(resolvedRoot, requestedPath);
  const rootStat = await lstat(resolvedRoot);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Symbolic-link authority root blocked: ${root}`);
  }

  const rootReal = await realpath(resolvedRoot);
  const rel = relative(resolvedRoot, target);
  const parts = rel === "" ? [] : rel.split(sep).filter(Boolean);
  let cursor = resolvedRoot;
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic-link path component blocked: ${relative(resolvedRoot, cursor)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return target;
      }
      throw error;
    }
  }

  const targetReal = await realpath(target);
  const canonicalRel = relative(rootReal, targetReal);
  if (canonicalRel.startsWith("..") || isAbsolute(canonicalRel)) {
    throw new Error(`Canonical path escaped authority root: ${requestedPath}`);
  }
  return targetReal;
}
