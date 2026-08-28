import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  DetachedPayloadLeaseSourceRefSchema,
  OwnerDirectionReferenceSchema,
  directionTextSha256,
  type OwnerDirectionReference,
  type ResolvedOwnerDirection,
} from "./direction-context.js";

const DEFAULT_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const ORPHAN_RETENTION_MS = 48 * 60 * 60 * 1_000;
const LEASES_RELATIVE_DIR = ".inkos/private/detached-payload-leases";

const DetachedPayloadLeaseReceiptSchema = z.object({
  schemaVersion: z.literal("detached-payload-lease/v1"),
  leaseId: z.string().uuid(),
  receiptId: z.string().trim().min(1).max(240),
  payloadFile: z.string().regex(/^[a-f0-9-]+\.payload$/),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().min(1),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  retryPolicy: z.literal("same-lease-or-identical-bytes"),
}).strict();
type DetachedPayloadLeaseReceipt = z.infer<typeof DetachedPayloadLeaseReceiptSchema>;

function leaseDirectory(projectRoot: string): string {
  return join(projectRoot, LEASES_RELATIVE_DIR);
}

function receiptPath(projectRoot: string, leaseId: string): string {
  return join(leaseDirectory(projectRoot), `${leaseId}.receipt.json`);
}

function payloadPath(projectRoot: string, leaseId: string): string {
  return join(leaseDirectory(projectRoot), `${leaseId}.payload`);
}

async function syncParentDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dirname(path), "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writePrivateAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    renamed = true;
    await chmod(path, 0o600);
    await syncParentDirectory(path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (renamed) await rm(path, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertRegularPrivateFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Detached payload path is not a regular file: ${path}`);
  }
}

export async function createDetachedOwnerDirectionLease(input: {
  readonly projectRoot: string;
  readonly receiptId: string;
  readonly text: string;
  readonly ttlMs?: number;
  readonly now?: Date;
}): Promise<OwnerDirectionReference> {
  const text = input.text;
  if (text.length === 0) throw new Error("Owner direction cannot be empty.");
  const receiptId = input.receiptId.trim();
  if (!receiptId) throw new Error("Owner direction receiptId cannot be empty.");
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("Detached payload lease ttlMs must be positive.");

  const directory = leaseDirectory(input.projectRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await cleanupExpiredDetachedPayloadLeases(input.projectRoot, { now }).catch(() => undefined);

  const leaseId = randomUUID();
  const payloadBytes = Buffer.from(text, "utf8");
  const payloadSha256 = directionTextSha256(text);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const receipt: DetachedPayloadLeaseReceipt = DetachedPayloadLeaseReceiptSchema.parse({
    schemaVersion: "detached-payload-lease/v1",
    leaseId,
    receiptId,
    payloadFile: `${leaseId}.payload`,
    payloadSha256,
    byteLength: payloadBytes.byteLength,
    createdAt,
    expiresAt,
    retryPolicy: "same-lease-or-identical-bytes",
  });
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  await writePrivateAtomic(payloadPath(input.projectRoot, leaseId), payloadBytes);
  try {
    await writePrivateAtomic(receiptPath(input.projectRoot, leaseId), receiptBytes);
  } catch (error) {
    await rm(payloadPath(input.projectRoot, leaseId), { force: true });
    throw error;
  }

  return OwnerDirectionReferenceSchema.parse({
    source: "owner-confirmed",
    receiptId,
    sourceRef: {
      kind: "detached-payload-lease",
      leaseId,
      payloadSha256,
      byteLength: payloadBytes.byteLength,
      expiresAt,
      leaseReceiptSha256: directionTextSha256(receiptBytes.toString("utf8")),
    },
    textSha256: payloadSha256,
  });
}

export async function resolveDetachedOwnerDirectionLease(input: {
  readonly projectRoot: string;
  readonly reference: OwnerDirectionReference;
  readonly now?: Date;
}): Promise<ResolvedOwnerDirection> {
  const reference = OwnerDirectionReferenceSchema.parse(input.reference);
  const now = input.now ?? new Date();
  if (Date.parse(reference.sourceRef.expiresAt) <= now.getTime()) {
    throw new Error(`Detached owner direction lease expired: ${reference.sourceRef.leaseId}`);
  }

  const storedReceiptPath = receiptPath(input.projectRoot, reference.sourceRef.leaseId);
  const storedPayloadPath = payloadPath(input.projectRoot, reference.sourceRef.leaseId);
  await Promise.all([
    assertRegularPrivateFile(storedReceiptPath),
    assertRegularPrivateFile(storedPayloadPath),
  ]).catch(() => {
    throw new Error(`Detached owner direction lease is unavailable: ${reference.sourceRef.leaseId}`);
  });
  const [receiptBytes, payloadBytes] = await Promise.all([
    readFile(storedReceiptPath),
    readFile(storedPayloadPath),
  ]);
  if (directionTextSha256(receiptBytes.toString("utf8")) !== reference.sourceRef.leaseReceiptSha256) {
    throw new Error(`Detached owner direction receipt hash mismatch: ${reference.sourceRef.leaseId}`);
  }
  const receipt = DetachedPayloadLeaseReceiptSchema.parse(JSON.parse(receiptBytes.toString("utf8")));
  const expectedSourceRef = DetachedPayloadLeaseSourceRefSchema.parse(reference.sourceRef);
  if (
    receipt.leaseId !== expectedSourceRef.leaseId
    || receipt.receiptId !== reference.receiptId
    || receipt.payloadFile !== `${expectedSourceRef.leaseId}.payload`
    || receipt.payloadSha256 !== expectedSourceRef.payloadSha256
    || receipt.byteLength !== expectedSourceRef.byteLength
    || receipt.expiresAt !== expectedSourceRef.expiresAt
  ) {
    throw new Error(`Detached owner direction receipt does not match its reference: ${reference.sourceRef.leaseId}`);
  }
  if (payloadBytes.byteLength !== reference.sourceRef.byteLength) {
    throw new Error(`Detached owner direction byte length mismatch: ${reference.sourceRef.leaseId}`);
  }
  const text = payloadBytes.toString("utf8");
  const payloadSha256 = directionTextSha256(text);
  if (payloadSha256 !== reference.sourceRef.payloadSha256 || payloadSha256 !== reference.textSha256) {
    throw new Error(`Detached owner direction payload hash mismatch: ${reference.sourceRef.leaseId}`);
  }
  return { ...reference, text };
}

export async function cleanupExpiredDetachedPayloadLeases(
  projectRoot: string,
  options: { readonly now?: Date } = {},
): Promise<number> {
  const directory = leaseDirectory(projectRoot);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return 0;
  }
  const nowMs = (options.now ?? new Date()).getTime();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".receipt.json")) continue;
    const leaseId = entry.slice(0, -".receipt.json".length);
    try {
      const raw = await readFile(join(directory, entry), "utf8");
      const receipt = DetachedPayloadLeaseReceiptSchema.parse(JSON.parse(raw));
      if (Date.parse(receipt.expiresAt) > nowMs) continue;
      await Promise.all([
        rm(join(directory, entry), { force: true }),
        rm(payloadPath(projectRoot, leaseId), { force: true }),
      ]);
      removed += 1;
    } catch {
      // Malformed receipts are never trusted or followed. Leave them quarantined
      // for explicit operator inspection rather than guessing their payload path.
    }
  }
  for (const entry of entries) {
    const fullPath = join(directory, entry);
    if (entry.includes(".tmp-")) {
      try {
        const info = await lstat(fullPath);
        if (info.isFile() && info.mtimeMs <= nowMs - ORPHAN_RETENTION_MS) {
          await rm(fullPath, { force: true });
        }
      } catch {
        // A concurrent writer may already have renamed or removed the temp.
      }
      continue;
    }
    if (!entry.endsWith(".payload")) continue;
    const leaseId = entry.slice(0, -".payload".length);
    try {
      await lstat(receiptPath(projectRoot, leaseId));
      continue;
    } catch {
      // Only a sufficiently old payload without a receipt is an orphan.
    }
    try {
      const info = await lstat(fullPath);
      if (info.isFile() && info.mtimeMs <= nowMs - ORPHAN_RETENTION_MS) {
        await rm(fullPath, { force: true });
      }
    } catch {
      // A concurrent writer may have completed or removed the lease.
    }
  }
  return removed;
}
