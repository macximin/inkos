import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { StateManager } from "../state/manager.js";
import { runBookMutationTransaction } from "../state/book-mutation-journal.js";
import { commitAtomicFileSet, syncDirectory } from "../utils/atomic-file-set.js";
import {
  ActiveSoulPointerSchema,
  BookSoulBindingSchema,
  SessionSoulBindingSchema,
  SoulBindingDecisionReceiptSchema,
  SoulPackageManifestSchema,
  type ActiveSoulPointer,
  type BookSoulBinding,
  type SessionSoulBinding,
  type SoulLifecycle,
} from "./soul-schema.js";
import {
  ProductionSoulInputReceiptSchema,
  hashCanonical,
  sha256Bytes,
  type ProductionSoulInputReceipt,
} from "./production-input.js";

const SOUL_OBJECT_ROOT = join(".inkos", "production", "souls", "objects");
const BINDING_ROOT = join("story", "soul-bindings");
const ACTIVE_POINTER_PATH = join(BINDING_ROOT, "current.json");
const ALLOWED_TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl", ".yaml", ".yml"]);
const MAX_SOUL_FILE_BYTES = 512 * 1024;
const MAX_SOUL_PACKAGE_BYTES = 2 * 1024 * 1024;

export interface BindBookSoulInput {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly manifestPath: string;
  readonly sourceRegistryReceiptPath: string;
  readonly decisionReceiptPath: string;
  readonly status: SoulLifecycle;
  readonly now?: () => Date;
}

export interface ResolvedBookSoulInput {
  readonly binding: BookSoulBinding;
  readonly sessionBinding: SessionSoulBinding;
  readonly promptInput: string;
  readonly receipt: ProductionSoulInputReceipt;
}

interface ValidatedTextFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly text: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function safeRelativePath(value: string): string {
  const normalized = normalize(value);
  if (
    !value.trim()
    || isAbsolute(value)
    || normalized !== value
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith(`..${sep}`)
  ) {
    throw new Error(`Soul package path must stay inside its package: ${value}`);
  }
  return normalized;
}

function decodeUtf8(bytes: Buffer, label: string): string {
  if (bytes.includes(0)) throw new Error(`Soul text contains NUL bytes: ${label}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Soul text is not valid UTF-8: ${label}`, { cause: error });
  }
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
}

async function readSecureText(root: string, relativePath: string): Promise<ValidatedTextFile> {
  const safePath = safeRelativePath(relativePath);
  if (!ALLOWED_TEXT_EXTENSIONS.has(extname(safePath).toLowerCase())) {
    throw new Error(`Soul resource extension is not allowed: ${safePath}`);
  }
  await assertRealDirectory(root, "Soul package root");
  const parts = safePath.split(sep);
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]!);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`Soul package symlink is not allowed: ${safePath}`);
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(`Soul package path component is not a directory: ${safePath}`);
    }
    if (index === parts.length - 1 && !info.isFile()) {
      throw new Error(`Soul package resource is not a regular file: ${safePath}`);
    }
  }
  const bytes = await readFile(cursor);
  if (bytes.byteLength > MAX_SOUL_FILE_BYTES) {
    throw new Error(`Soul resource exceeds ${MAX_SOUL_FILE_BYTES} bytes: ${safePath}`);
  }
  return {
    path: safePath,
    bytes,
    text: decodeUtf8(bytes, safePath),
    sha256: sha256Bytes(bytes),
    sizeBytes: bytes.byteLength,
  };
}

function bindingRelativePath(version: number): string {
  return join(BINDING_ROOT, `v${String(version).padStart(4, "0")}.json`);
}

function decisionRelativePath(decisionId: string): string {
  const safeId = decisionId.replace(/[^a-zA-Z0-9._-]+/gu, "-");
  if (!safeId || safeId !== decisionId) throw new Error("Soul decision ID must be filesystem-safe.");
  return join(BINDING_ROOT, "decisions", `${safeId}.json`);
}

function objectDir(projectRoot: string, objectSha256: string): string {
  return join(projectRoot, SOUL_OBJECT_ROOT, objectSha256);
}

async function assertUnusedDecisionReceipt(bookDir: string, decisionId: string): Promise<void> {
  const path = join(bookDir, decisionRelativePath(decisionId));
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error(`Soul binding decision ID is already used: ${decisionId}`);
}

async function readRegular(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Soul evidence is not a regular file: ${path}`);
  return readFile(path);
}

async function installSoulObject(input: {
  readonly projectRoot: string;
  readonly objectSha256: string;
  readonly manifestBytes: Buffer;
  readonly sourceRegistryReceiptBytes: Buffer;
  readonly resources: ReadonlyArray<ValidatedTextFile>;
}): Promise<void> {
  const destination = objectDir(input.projectRoot, input.objectSha256);
  try {
    await assertRealDirectory(destination, "Installed Soul object");
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const root = join(input.projectRoot, SOUL_OBJECT_ROOT);
  await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(join(root, ".install-"));
  try {
    await writeFile(join(temporary, "manifest.json"), input.manifestBytes);
    await writeFile(join(temporary, "source-registry-receipt.json"), input.sourceRegistryReceiptBytes);
    for (const resource of input.resources) {
      const target = join(temporary, "resources", resource.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, resource.bytes);
    }
    await syncDirectory(temporary);
    try {
      await rename(temporary, destination);
      await syncDirectory(root);
    } catch (error) {
      if (!isMissing(error)) {
        try {
          await assertRealDirectory(destination, "Installed Soul object");
        } catch {
          throw error;
        }
      } else {
        throw error;
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function nextBindingVersion(bookDir: string): Promise<number> {
  let names: string[] = [];
  try {
    names = await readdir(join(bookDir, BINDING_ROOT));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const versions = names.flatMap((name) => {
    const match = /^v(\d{4,})\.json$/u.exec(name);
    return match ? [Number(match[1])] : [];
  });
  return (versions.length > 0 ? Math.max(...versions) : 0) + 1;
}

export function sessionSoulBinding(binding: BookSoulBinding): SessionSoulBinding {
  return SessionSoulBindingSchema.parse({
    soulId: binding.soulId,
    soulVersion: binding.version,
    bindingSha256: binding.bindingSha256,
  });
}

export function sessionSoulBindingsEqual(
  left: SessionSoulBinding | null | undefined,
  right: SessionSoulBinding | null | undefined,
): boolean {
  return hashCanonical(left ?? null) === hashCanonical(right ?? null);
}

export class BookSoulStore {
  constructor(
    private readonly projectRoot: string,
    private readonly bookDir: string,
    private readonly bookId: string,
  ) {}

  private async loadHistory(): Promise<BookSoulBinding[]> {
    let names: string[] = [];
    try {
      names = await readdir(join(this.bookDir, BINDING_ROOT));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const versioned = names.flatMap((name) => {
      const match = /^v(\d{4,})\.json$/u.exec(name);
      return match ? [{ name, version: Number(match[1]) }] : [];
    }).sort((left, right) => left.version - right.version);
    const history: BookSoulBinding[] = [];
    for (const [index, entry] of versioned.entries()) {
      if (entry.version !== index + 1) throw new Error("Soul binding history has a version gap.");
      const bytes = await readRegular(join(this.bookDir, BINDING_ROOT, entry.name));
      const binding = BookSoulBindingSchema.parse(JSON.parse(decodeUtf8(bytes, entry.name)));
      const { bindingSha256: _self, ...unsigned } = binding;
      if (
        binding.bindingVersion !== entry.version
        || binding.bookId !== this.bookId
        || hashCanonical(unsigned) !== binding.bindingSha256
        || binding.previousBindingSha256 !== (history.at(-1)?.bindingSha256 ?? null)
      ) {
        throw new Error(`Soul binding history integrity failed at ${entry.name}.`);
      }
      const decisionBytes = await readRegular(join(this.bookDir, decisionRelativePath(binding.boundByDecisionReceipt)));
      if (sha256Bytes(decisionBytes) !== binding.decisionReceiptSha256) {
        throw new Error(`Soul binding decision receipt hash mismatch at ${entry.name}.`);
      }
      const decision = SoulBindingDecisionReceiptSchema.parse(JSON.parse(decodeUtf8(decisionBytes, entry.name)));
      if (
        decision.decisionId !== binding.boundByDecisionReceipt
        || decision.bookId !== binding.bookId
        || decision.soulId !== binding.soulId
        || decision.soulVersion !== binding.version
        || decision.status !== binding.status
      ) {
        throw new Error(`Soul binding decision does not authorize ${entry.name}.`);
      }
      history.push(binding);
    }
    return history;
  }

  async loadActive(required = false): Promise<BookSoulBinding | null> {
    let pointerBytes: Buffer;
    try {
      pointerBytes = await readRegular(join(this.bookDir, ACTIVE_POINTER_PATH));
    } catch (error) {
      if (isMissing(error) && !required) {
        if ((await this.loadHistory()).length > 0) {
          throw new Error("Soul binding history exists without an active pointer.");
        }
        return null;
      }
      throw new Error(`Active Soul pointer cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const pointer = ActiveSoulPointerSchema.parse(JSON.parse(decodeUtf8(pointerBytes, ACTIVE_POINTER_PATH)));
    const { pointerSha256: _self, ...pointerUnsigned } = pointer;
    if (hashCanonical(pointerUnsigned) !== pointer.pointerSha256 || pointer.bookId !== this.bookId) {
      throw new Error("Active Soul pointer integrity check failed.");
    }
    const bindingBytes = await readRegular(join(this.bookDir, pointer.bindingPath));
    const binding = BookSoulBindingSchema.parse(JSON.parse(decodeUtf8(bindingBytes, pointer.bindingPath)));
    const { bindingSha256: _bindingSelf, ...bindingUnsigned } = binding;
    if (
      hashCanonical(bindingUnsigned) !== binding.bindingSha256
      || binding.bindingSha256 !== pointer.bindingSha256
      || binding.bindingVersion !== pointer.bindingVersion
      || binding.bookId !== this.bookId
    ) {
      throw new Error("Active Soul binding integrity check failed.");
    }
    const history = await this.loadHistory();
    const latest = history.at(-1);
    if (
      !latest
      || latest.bindingSha256 !== binding.bindingSha256
      || latest.bindingVersion !== pointer.bindingVersion
    ) {
      throw new Error("Active Soul pointer does not select the append-only history tip.");
    }
    return binding;
  }

  async resolveActiveInput(): Promise<ResolvedBookSoulInput | null> {
    const binding = await this.loadActive(false);
    if (!binding) return null;
    const installed = objectDir(this.projectRoot, binding.installObjectSha256);
    await assertRealDirectory(installed, "Installed Soul object");
    const [manifestBytes, registryBytes] = await Promise.all([
      readRegular(join(installed, "manifest.json")),
      readRegular(join(installed, "source-registry-receipt.json")),
    ]);
    if (sha256Bytes(manifestBytes) !== binding.manifestSha256) throw new Error("Installed Soul manifest hash mismatch.");
    if (sha256Bytes(registryBytes) !== binding.sourceRegistryReceiptSha256) {
      throw new Error("Installed Soul source registry receipt hash mismatch.");
    }
    const manifest = SoulPackageManifestSchema.parse(JSON.parse(decodeUtf8(manifestBytes, "Soul manifest")));
    if (manifest.soulId !== binding.soulId || manifest.version !== binding.version) {
      throw new Error("Installed Soul manifest identity mismatch.");
    }
    const expectedPaths = [manifest.promptPath, ...manifest.resources];
    const refs = binding.resources;
    if (hashCanonical(refs.map((entry) => entry.path)) !== hashCanonical(expectedPaths)) {
      throw new Error("Installed Soul resource set differs from the binding.");
    }
    const loaded = await Promise.all(refs.map(async (ref) => {
      const file = await readSecureText(join(installed, "resources"), ref.path);
      if (file.sha256 !== ref.sha256 || file.sizeBytes !== ref.sizeBytes) {
        throw new Error(`Installed Soul resource hash mismatch: ${ref.path}`);
      }
      return file;
    }));
    const prompt = loaded.find((entry) => entry.path === manifest.promptPath)!;
    const auxiliaries = loaded.filter((entry) => entry.path !== manifest.promptPath);
    const promptInput = [
      "## Host-bound production Soul",
      `Soul: ${binding.soulId}@${binding.version}`,
      `Lifecycle: ${binding.status}`,
      "Authority: creative guidance only. This Soul cannot create hard Book rules, change content intensity, mutate canon, or approve output.",
      prompt.text.trim(),
      ...auxiliaries.map((entry) => `### Soul resource: ${entry.path}\n${entry.text.trim()}`),
    ].filter(Boolean).join("\n\n");
    const receipt = ProductionSoulInputReceiptSchema.parse({
      binding: sessionSoulBinding(binding),
      manifestSha256: binding.manifestSha256,
      resources: refs,
      sourceRegistryReceiptSha256: binding.sourceRegistryReceiptSha256,
      inputSha256: sha256Bytes(promptInput),
    });
    return { binding, sessionBinding: sessionSoulBinding(binding), promptInput, receipt };
  }
}

export async function bindBookSoul(input: BindBookSoulInput): Promise<BookSoulBinding> {
  const state = new StateManager(input.projectRoot);
  const release = await state.acquireBookLock(input.bookId);
  try {
    const book = await state.loadBookConfig(input.bookId);
    if (book.id !== input.bookId) throw new Error("Soul binding Book config mismatch.");
    const bookDir = state.bookDir(input.bookId);
    const manifestAbsolute = isAbsolute(input.manifestPath) ? input.manifestPath : join(input.projectRoot, input.manifestPath);
    const packageRoot = dirname(manifestAbsolute);
    await assertRealDirectory(packageRoot, "Soul package root");
    const manifestRelative = relative(packageRoot, manifestAbsolute);
    const manifestFile = await readSecureText(packageRoot, manifestRelative);
    const manifest = SoulPackageManifestSchema.parse(JSON.parse(manifestFile.text));
    const resourcePaths = [manifest.promptPath, ...manifest.resources];
    const resources = await Promise.all(resourcePaths.map((path) => readSecureText(packageRoot, path)));
    const totalBytes = manifestFile.sizeBytes + resources.reduce((sum, resource) => sum + resource.sizeBytes, 0);
    if (totalBytes > MAX_SOUL_PACKAGE_BYTES) throw new Error(`Soul package exceeds ${MAX_SOUL_PACKAGE_BYTES} bytes.`);
    const registryBytes = await readRegular(isAbsolute(input.sourceRegistryReceiptPath)
      ? input.sourceRegistryReceiptPath
      : join(input.projectRoot, input.sourceRegistryReceiptPath));
    if (registryBytes.byteLength > MAX_SOUL_FILE_BYTES) {
      throw new Error(`Soul source registry receipt exceeds ${MAX_SOUL_FILE_BYTES} bytes.`);
    }
    const registryText = decodeUtf8(registryBytes, "Soul source registry receipt");
    const registryJson = JSON.parse(registryText);
    if (!registryJson || typeof registryJson !== "object" || Array.isArray(registryJson)) {
      throw new Error("Soul source registry receipt must be a JSON object.");
    }
    const decisionBytes = await readRegular(isAbsolute(input.decisionReceiptPath)
      ? input.decisionReceiptPath
      : join(input.projectRoot, input.decisionReceiptPath));
    if (decisionBytes.byteLength > MAX_SOUL_FILE_BYTES) {
      throw new Error(`Soul decision receipt exceeds ${MAX_SOUL_FILE_BYTES} bytes.`);
    }
    const decision = SoulBindingDecisionReceiptSchema.parse(JSON.parse(decodeUtf8(decisionBytes, "Soul decision receipt")));
    if (
      decision.bookId !== input.bookId
      || decision.soulId !== manifest.soulId
      || decision.soulVersion !== manifest.version
      || decision.status !== input.status
    ) {
      throw new Error("Soul binding decision receipt does not match the requested binding.");
    }
    await assertUnusedDecisionReceipt(bookDir, decision.decisionId);
    const resourceRefs = resources.map((resource) => ({
      path: resource.path,
      sha256: resource.sha256,
      sizeBytes: resource.sizeBytes,
    }));
    const objectSha256 = hashCanonical({
      manifestSha256: manifestFile.sha256,
      sourceRegistryReceiptSha256: sha256Bytes(registryBytes),
      resources: resourceRefs,
    });
    await installSoulObject({
      projectRoot: input.projectRoot,
      objectSha256,
      manifestBytes: manifestFile.bytes,
      sourceRegistryReceiptBytes: registryBytes,
      resources,
    });
    const installed = objectDir(input.projectRoot, objectSha256);
    const [installedManifest, installedRegistry, ...installedResources] = await Promise.all([
      readRegular(join(installed, "manifest.json")),
      readRegular(join(installed, "source-registry-receipt.json")),
      ...resourceRefs.map((resource) => readSecureText(join(installed, "resources"), resource.path)),
    ]);
    if (
      sha256Bytes(installedManifest) !== manifestFile.sha256
      || sha256Bytes(installedRegistry) !== sha256Bytes(registryBytes)
      || installedResources.some((resource, index) => (
        resource.sha256 !== resourceRefs[index]!.sha256
        || resource.sizeBytes !== resourceRefs[index]!.sizeBytes
      ))
    ) {
      throw new Error("Installed Soul object failed content-addressed readback.");
    }
    const store = new BookSoulStore(input.projectRoot, bookDir, input.bookId);
    const previous = await store.loadActive(false);
    const version = await nextBindingVersion(bookDir);
    const boundAt = (input.now ?? (() => new Date()))().toISOString();
    const unsigned = {
      schemaVersion: "book-soul-binding/v1" as const,
      bindingVersion: version,
      bookId: input.bookId,
      soulId: manifest.soulId,
      version: manifest.version,
      manifestSha256: manifestFile.sha256,
      resources: resourceRefs,
      sourceRegistryReceiptSha256: sha256Bytes(registryBytes),
      installObjectSha256: objectSha256,
      status: input.status,
      boundByDecisionReceipt: decision.decisionId,
      decisionReceiptSha256: sha256Bytes(decisionBytes),
      previousBindingSha256: previous?.bindingSha256 ?? null,
      boundAt,
    };
    const binding = BookSoulBindingSchema.parse({ ...unsigned, bindingSha256: hashCanonical(unsigned) });
    const bindingPath = bindingRelativePath(version);
    const pointerUnsigned = {
      schemaVersion: "active-soul-pointer/v1" as const,
      bookId: input.bookId,
      bindingVersion: version,
      bindingPath: bindingPath.split(sep).join("/"),
      bindingSha256: binding.bindingSha256,
      updatedAt: boundAt,
    };
    const pointer: ActiveSoulPointer = ActiveSoulPointerSchema.parse({
      ...pointerUnsigned,
      pointerSha256: hashCanonical(pointerUnsigned),
    });
    const decisionPath = decisionRelativePath(decision.decisionId);
    await runBookMutationTransaction({
      bookDir,
      kind: "bind-book-soul",
      relativePaths: [bindingPath, ACTIVE_POINTER_PATH, decisionPath],
      persist: () => commitAtomicFileSet({
        rootDir: bookDir,
        writes: [
          { relativePath: bindingPath, content: `${JSON.stringify(binding, null, 2)}\n` },
          { relativePath: ACTIVE_POINTER_PATH, content: `${JSON.stringify(pointer, null, 2)}\n` },
          { relativePath: decisionPath, content: decisionBytes },
        ],
      }),
    });
    return await store.loadActive(true) ?? binding;
  } finally {
    await release();
  }
}

export async function loadActiveBookSoulBinding(projectRoot: string, bookId: string): Promise<BookSoulBinding | null> {
  const state = new StateManager(projectRoot);
  return new BookSoulStore(projectRoot, state.bookDir(bookId), bookId).loadActive(false);
}

export async function loadActiveBookSoulSessionBinding(
  projectRoot: string,
  bookId: string,
): Promise<SessionSoulBinding | null> {
  const binding = await loadActiveBookSoulBinding(projectRoot, bookId);
  return binding ? sessionSoulBinding(binding) : null;
}
