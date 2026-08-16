import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ActiveArcSchema, ArcPacketSchema, type ArcPacket } from "./schema.js";

export interface ArcStoreOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export function assertSafeArcId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) throw new Error(`Invalid arc id: ${JSON.stringify(value)}`);
  return value;
}

/** Book-local Arc storage. It deliberately does not alter chapter or state files. */
export class ArcStore {
  constructor(private readonly bookDir: string, private readonly options: ArcStoreOptions = {}) {}

  get arcsDir(): string { return join(this.bookDir, "story", "arcs"); }
  get activePath(): string { return join(this.arcsDir, "active.json"); }
  arcPath(id: string): string { return join(this.arcsDir, `${assertSafeArcId(id)}.json`); }
  now(): Date { return (this.options.now ?? (() => new Date()))(); }

  async allocateArcId(): Promise<string> {
    const base = assertSafeArcId(this.options.idFactory?.()
      ?? `arc-${this.now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID()}`);
    let candidate = base;
    for (let suffix = 2; await exists(this.arcPath(candidate)); suffix += 1) candidate = `${base}-${suffix}`;
    return candidate;
  }

  async save(arc: ArcPacket): Promise<ArcPacket> {
    const validated = ArcPacketSchema.parse(arc);
    await mkdir(this.arcsDir, { recursive: true });
    await writeJsonAtomically(this.arcPath(validated.id), validated);
    return validated;
  }

  async load(id: string): Promise<ArcPacket> {
    const path = this.arcPath(id);
    try {
      return ArcPacketSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error(`Arc ${JSON.stringify(id)} not found.`);
      throw new Error(`Arc ${JSON.stringify(id)} cannot be read: ${String(error)}`);
    }
  }

  async list(): Promise<ReadonlyArray<ArcPacket>> {
    let entries: string[];
    try { entries = await readdir(this.arcsDir); } catch { return []; }
    const arcs = await Promise.all(entries.filter((entry) => entry.endsWith(".json") && entry !== "active.json").map(async (entry) => this.load(entry.slice(0, -5))));
    return arcs.sort((a, b) => a.chapterNumbers[0]! - b.chapterNumbers[0]! || a.createdAt.localeCompare(b.createdAt));
  }

  async setActive(id: string): Promise<ArcPacket> {
    const arc = await this.load(id);
    await mkdir(this.arcsDir, { recursive: true });
    await writeJsonAtomically(this.activePath, { arcId: arc.id, updatedAt: this.now().toISOString() });
    return arc;
  }

  async getActive(): Promise<ArcPacket | null> {
    try {
      const active = ActiveArcSchema.parse(JSON.parse(await readFile(this.activePath, "utf8")));
      return await this.load(active.arcId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
      throw error;
    }
  }
}

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}
