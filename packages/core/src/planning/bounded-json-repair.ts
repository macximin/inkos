import { createHash } from "node:crypto";

type Path = readonly (string | number)[];
export interface BoundedJsonRepairIssue {
  readonly path: Path;
  readonly code: string;
  readonly message: string;
}
export type BoundedJsonRepairRule = {
  readonly kind: "integer";
  readonly path: Path;
  readonly min: number;
  readonly max: number;
} | {
  readonly kind: "sum";
  readonly path: Path;
  readonly componentPaths: readonly Path[];
  readonly min: number;
  readonly max: number;
};
type Before = { readonly exists: false } | { readonly exists: true; readonly value: unknown };
interface Change {
  readonly path: Path;
  readonly before: Before;
  readonly after: number;
}
export interface BoundedJsonRepairRequest {
  readonly schemaVersion: "bounded-json-repair-request/v1";
  readonly originalSha256: string;
  readonly issues: readonly BoundedJsonRepairIssue[];
  readonly rules: readonly BoundedJsonRepairRule[];
  readonly protectedPaths: readonly Path[];
  readonly allowedChanges: readonly Change[];
  readonly requestSha256: string;
}
export interface BoundedJsonRepairPatch {
  readonly schemaVersion: "bounded-json-repair-patch/v1";
  readonly originalSha256: string;
  readonly requestSha256: string;
  readonly changes: readonly Change[];
}

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null) throw new Error("Repair requires JSON-safe values");
  if (ancestors.has(value)) throw new Error("Repair cannot process circular JSON");
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("Repair requires plain JSON objects and arrays");
  if (Object.getOwnPropertySymbols(value).length) throw new Error("Repair does not allow symbol properties");
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    if (Object.keys(descriptors).length !== value.length + 1) throw new Error("Repair does not allow sparse or extended arrays");
    for (let index = 0; index < value.length; index++) if (!Object.hasOwn(descriptors, index)) throw new Error("Repair does not allow sparse arrays");
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === "length") continue;
    if (forbidden.has(key) || !("value" in descriptor) || !descriptor.enumerable) throw new Error("Repair rejected an unsafe JSON property");
    assertJson(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function hashBoundedJson(value: unknown): string {
  assertJson(value);
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function assertPath(path: Path): void {
  if (!Array.isArray(path) || !path.length || path.some((part) => typeof part === "string"
    ? !part.length || forbidden.has(part) : !Number.isSafeInteger(part) || part < 0)) throw new Error("Repair rejected an unsafe or root path");
}
const samePath = (a: Path, b: Path) => a.length === b.length && a.every((part, index) => part === b[index]);
const overlaps = (a: Path, b: Path) => a.slice(0, Math.min(a.length, b.length)).every((part, index) => part === b[index]);
function parentAt(value: unknown, path: Path): { parent: Record<string, unknown>; key: string } {
  assertPath(path);
  let current = value;
  for (let index = 0; index < path.length; index++) {
    const key = path[index];
    // This version repairs object scalars only; arrays, IDs and sequence order have no mutation operation.
    if (current === null || typeof current !== "object" || Array.isArray(current) || typeof key !== "string") throw new Error("Repair cannot traverse or modify an array or non-object");
    const parent = current as Record<string, unknown>;
    if (index === path.length - 1) return { parent, key };
    if (!Object.hasOwn(parent, key)) throw new Error("Repair path has a missing parent");
    current = parent[key];
  }
  throw new Error("Repair path is missing");
}
function beforeAt(value: unknown, path: Path): Before {
  const { parent, key } = parentAt(value, path);
  return Object.hasOwn(parent, key) ? { exists: true, value: parent[key] } : { exists: false };
}
function setAt(value: unknown, change: Change): void {
  const { parent, key } = parentAt(value, change.path);
  parent[key] = change.after;
}
function strictInteger(value: unknown, min: number, max: number): number {
  // No whitespace, decimal notation, exponent, sign guessing or partial parse.
  const parsed = typeof value === "string" && /^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error("Repair cannot prove an integer conversion preserves the value");
  return parsed;
}

/** Host-owned rules only. Missing narrative/evidence and unlocated issues have no repair rule. */
export function buildBoundedJsonRepairRequest(params: {
  readonly original: unknown;
  readonly issues: readonly BoundedJsonRepairIssue[];
  readonly rules: readonly BoundedJsonRepairRule[];
  readonly protectedPaths?: readonly Path[];
}): BoundedJsonRepairRequest {
  const originalSha256 = hashBoundedJson(params.original);
  const protectedPaths = params.protectedPaths ?? [];
  assertJson(params.issues);
  assertJson(params.rules);
  assertJson(protectedPaths);
  for (const path of protectedPaths) assertPath(path);
  if (!params.issues.length || params.issues.length > 32 || !params.rules.length || params.rules.length > 32) throw new Error("Repair requires a bounded set of located issues and rules");
  for (const [index, rule] of params.rules.entries()) {
    assertPath(rule.path);
    if (rule.kind !== "integer" && rule.kind !== "sum") throw new Error("Unknown repair rule");
    if (!Number.isSafeInteger(rule.min) || !Number.isSafeInteger(rule.max) || rule.min > rule.max) throw new Error("Invalid repair bounds");
    if (protectedPaths.some((path) => overlaps(path, rule.path))) throw new Error("Repair rule overlaps a protected path");
    if (params.rules.slice(0, index).some((prior) => overlaps(prior.path, rule.path))) throw new Error("Repair rules have duplicate or overlapping paths");
    if (rule.kind === "sum") {
      if (!rule.componentPaths.length || rule.componentPaths.length > 32) throw new Error("Repair sum requires bounded components");
      for (const [componentIndex, path] of rule.componentPaths.entries()) {
        assertPath(path);
        if (overlaps(path, rule.path) || rule.componentPaths.slice(0, componentIndex).some((prior) => overlaps(prior, path))) throw new Error("Repair sum has overlapping or duplicate components");
      }
    }
  }
  for (const issue of params.issues) {
    assertPath(issue.path);
    if (!issue.code.trim() || !issue.message.trim() || !params.rules.some((rule) => samePath(rule.path, issue.path))) throw new Error("No content-preserving repair rule for a contract issue");
  }
  const working: unknown = JSON.parse(JSON.stringify(params.original));
  const allowedChanges: Change[] = [];
  // Integer conversion happens before derived totals, independent of caller rule order.
  const orderedRules = [...params.rules].sort((a, b) => Number(a.kind === "sum") - Number(b.kind === "sum"));
  for (const rule of orderedRules) {
    const before = beforeAt(params.original, rule.path);
    let after: number;
    if (rule.kind === "integer") {
      if (!before.exists) throw new Error("Repair cannot invent a missing integer component");
      after = strictInteger(before.value, rule.min, rule.max);
    } else {
      const values = rule.componentPaths.map((path) => {
        const component = beforeAt(working, path);
        if (!component.exists) throw new Error("Repair sum has a missing component");
        return strictInteger(component.value, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      });
      after = strictInteger(values.reduce((sum, value) => sum + value, 0), rule.min, rule.max);
      if (before.exists && (typeof before.value === "object" || typeof before.value === "boolean")) throw new Error("Repair cannot replace a container or boolean with a sum");
    }
    if (!before.exists || before.value !== after) {
      const change = { path: [...rule.path], before, after };
      allowedChanges.push(change);
      setAt(working, change);
    }
  }
  if (!allowedChanges.length) throw new Error("No deterministic repair is available");
  const body = JSON.parse(JSON.stringify({ schemaVersion: "bounded-json-repair-request/v1", originalSha256, issues: params.issues, rules: params.rules, protectedPaths, allowedChanges })) as Omit<BoundedJsonRepairRequest, "requestSha256">;
  return { ...body, requestSha256: hashBoundedJson(body) };
}

export function createBoundedJsonRepairPatch(request: BoundedJsonRepairRequest): BoundedJsonRepairPatch {
  return JSON.parse(JSON.stringify({ schemaVersion: "bounded-json-repair-patch/v1", originalSha256: request.originalSha256, requestSha256: request.requestSha256, changes: request.allowedChanges }));
}

/** Atomic, independently validated application of the host's exact deterministic changes. */
export function applyBoundedJsonRepair<T>(params: {
  readonly original: T;
  readonly request: BoundedJsonRepairRequest;
  readonly patch: BoundedJsonRepairPatch;
  readonly validate: (value: T) => readonly unknown[];
}): T {
  const { original, request, patch } = params;
  if (hashBoundedJson(original) !== request.originalSha256) throw new Error("Repair original SHA mismatch");
  const reconstructed = buildBoundedJsonRepairRequest({ original, issues: request.issues, rules: request.rules, protectedPaths: request.protectedPaths });
  if (hashBoundedJson(reconstructed) !== hashBoundedJson(request)) throw new Error("Repair request SHA or deterministic values mismatch");
  if (hashBoundedJson(createBoundedJsonRepairPatch(request)) !== hashBoundedJson(patch)) throw new Error("Repair patch differs from the bound allowed paths, before values or deterministic replacements");
  const repaired = JSON.parse(JSON.stringify(original)) as T;
  for (const change of patch.changes) {
    if (hashBoundedJson(beforeAt(repaired, change.path)) !== hashBoundedJson(change.before)) throw new Error("Repair before value mismatch");
    setAt(repaired, change);
  }
  const repairedSha256 = hashBoundedJson(repaired);
  if (params.validate(repaired).length) throw new Error("Repaired JSON still fails the complete contract");
  if (hashBoundedJson(repaired) !== repairedSha256) throw new Error("Complete contract validation mutated the bound repaired JSON");
  return repaired;
}
