import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

/** Validate advisory output destinations before mkdir/write while the caller holds the Book lease. */
export async function assertBookAdvisoryWritePaths(bookDir: string, relativePaths: ReadonlyArray<string>): Promise<void> {
  for (const path of relativePaths) {
    if (typeof path !== "string" || !path.trim() || isAbsolute(path) || path.includes("\\") || path.includes("\0")
      || normalize(path) !== path || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Book advisory output requires a normalized Book-relative file path");
    }
  }
  // A Book checkout itself may be reached through a link. Its resolved directory
  // is the authority root; all existing output components must remain inside it.
  const root = await realpath(bookDir);
  if (!(await stat(root)).isDirectory()) throw new Error("Book advisory authority root must be a directory");
  for (const path of relativePaths) {
    const parts = path.split("/");
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      let entry;
      try { entry = await lstat(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
      // lstat distinguishes an absent tail from a dangling link. Never treat a
      // link whose target is missing as a directory that we may create.
      let actual: string;
      try { actual = await realpath(current); }
      catch { throw new Error("Book advisory output has an unresolved path component or dangling symlink"); }
      if (!inside(root, actual)) throw new Error("Book advisory output escapes the Book through a symlink");
      const resolvedEntry = entry.isSymbolicLink() ? await stat(actual) : entry;
      if (index < parts.length - 1 ? !resolvedEntry.isDirectory() : !resolvedEntry.isFile()) {
        throw new Error("Book advisory output requires directory parents and a regular file destination");
      }
      current = actual;
    }
  }
}
