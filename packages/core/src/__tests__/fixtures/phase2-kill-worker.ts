import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateManager } from "../../state/manager.js";
import { beginChapterPersistenceJournal } from "../../state/chapter-persistence-journal.js";
import { beginBookMutationJournal } from "../../state/book-mutation-journal.js";
import { ReferenceTransformationHilStore } from "../../reference/hil-store.js";
import { createReferenceHilDecisionReceipt } from "../../reference/hil-apply-operation.js";
import { createProductionAttemptIdentity } from "../../production/attempt-identity.js";

const [mode, projectRoot, bookId] = process.argv.slice(2);
if (!mode || !projectRoot || !bookId) throw new Error("mode, projectRoot, and bookId are required");
const state = new StateManager(projectRoot);
await state.acquireBookLock(bookId);
const bookDir = state.bookDir(bookId);

if (mode === "chapter") {
  await beginChapterPersistenceJournal(bookDir, 1);
  await Promise.all([
    writeFile(join(bookDir, "chapters", "0001_One.md"), "# Chapter 1: One\n\nmutated", "utf8"),
    writeFile(join(bookDir, "story", "current_state.md"), "mutated state", "utf8"),
    writeFile(join(bookDir, "chapters", "index.json"), "[]\n", "utf8"),
    mkdir(join(bookDir, "story", "runtime", "chapter-commits"), { recursive: true }),
  ]);
  await writeFile(
    join(bookDir, "story", "runtime", "chapter-commits", "orphan.json"),
    "{\"orphan\":true}\n",
    "utf8",
  );
} else if (mode === "reference") {
  await beginBookMutationJournal({
    bookDir,
    kind: "reference-bind",
    relativePaths: [
      "book.json",
      join("story", "reference_binding.json"),
      join("story", "reference_transformation.json"),
      join("story", "rails", "plan.json"),
    ],
  });
  await mkdir(join(bookDir, "story", "rails"), { recursive: true });
  await Promise.all([
    writeFile(join(bookDir, "book.json"), "{\"mutated\":true}\n", "utf8"),
    writeFile(join(bookDir, "story", "reference_binding.json"), "{\"mutated\":true}\n", "utf8"),
    writeFile(join(bookDir, "story", "reference_transformation.json"), "{\"mutated\":true}\n", "utf8"),
    writeFile(join(bookDir, "story", "rails", "plan.json"), "{\"mutated\":true}\n", "utf8"),
  ]);
  const objectDir = join(projectRoot, ".inkos", "reference-packs", "objects", "orphan-object");
  await mkdir(objectDir, { recursive: true });
  await writeFile(join(objectDir, "reference-pack.json"), "{\"installed\":true}\n", "utf8");
} else if (mode === "hil") {
  const store = new ReferenceTransformationHilStore(bookDir);
  const view = await store.get(1, "kill-candidate");
  const productionAttempt = createProductionAttemptIdentity();
  const decision = createReferenceHilDecisionReceipt({
    actorId: "kill-worker-owner",
    interface: "studio",
    bookId,
    chapterNumber: 1,
    candidateId: "kill-candidate",
    currentContentSha256: view.candidate.currentContentSha256,
    candidateContentSha256: view.candidate.candidateContentSha256,
  });
  await store.apply({
    bookId,
    chapterNumber: 1,
    candidateId: "kill-candidate",
    targetChapterRelativePath: join("chapters", "0001_One.md"),
    productionAttempt,
    decision,
  });
} else {
  throw new Error(`unknown mode ${mode}`);
}

process.stdout.write("READY\n");
await new Promise(() => undefined);
