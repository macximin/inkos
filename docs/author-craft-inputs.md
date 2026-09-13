# Author craft inputs

Author craft packs provide bounded, source-linked references for an existing planning, writing, or revision call. A pack does not require a model call, new human feedback, or a training step to install or select.

## Command-line use

Build the workspace CLI, then run commands from the InkOS project containing `books/`:

```sh
pnpm --filter @actalk/inkos build
inkos craft import /path/to/pack.json
inkos craft preview --pack <printed-sha256> --stage writing --query '상대가 자기 조건 없이 제안을 받아들인다' --json
inkos craft enable my-book --pack <printed-sha256>
inkos craft status my-book
inkos craft history my-book --chapter 12 --stage writing
inkos craft disable my-book
```

When using this checkout without a linked `inkos` executable, substitute `node /absolute/path/to/packages/cli/dist/index.js` for `inkos`. Import and preview can run in an otherwise empty local project directory. Enable, status, and disable use the existing Book discovery rules.

Import copies validated bytes to `.inkos/author-craft-packs/<sha256>.json`; it does not enable a Book. Enable changes only `book.json`'s advisory selection and its update timestamp through the existing Book lock and mutation journal. Disable removes the selection while retaining the installed pack and prior receipts. Existing manuscript, canon, review mode, and unrelated Book extensions are preserved.

By default, matching uses the current problem and eligible stage, with at most three complete cases and 6,000 rendered characters. An unrelated query produces no added text. Explicit selection is available:

```sh
inkos craft enable my-book --pack <sha256> --case independent-counterparty earned-inner-decision --max-cases 2
inkos craft preview --pack <sha256> --stage revision --case revision-cause --json
```

Explicit IDs choose the eligible candidates; relevance still orders them when the budget cannot hold all of them. IDs for another stage remain configured but are not injected into the wrong stage. Unknown IDs, duplicate IDs, invalid budgets, changed installed bytes, and Book-language mismatch are rejected.

## Pack format

The contract is `author-craft-pack/v1` in `packages/core/src/models/author-craft.ts`. It contains:

- An ID, language (`ko`, `en`, `zh`), and `authority: "advisory"`.
- Sources with IDs, titles, references, optional SHA-256, a reading-scope statement, and evidence kind.
- Cases with stage eligibility, functions, search triggers, an observation, a possible method, strengths to preserve, counterexamples, and source IDs.

The pack parser validates structure and source-ID bindings. Import verifies the exact pack bytes; it does **not** fetch source URLs or certify each source's interpretation. An external manager can separately verify the declared source hashes. The Korean Reference Lab pack has a separate HQ asset validator for that purpose.

Cases are complete units. If a case cannot fit, the selector omits it together with its limitations instead of truncating away a counterexample. Korean, English, and Chinese wrappers identify the material as reference data; evidence itself is not translated.

## Runtime path

Planner uses the chapter goal, outline, and external direction to select planning references. Writer uses the memo and current intent. Reviser uses the existing revision instruction and audit issues; an automatic revision that has no work to do still returns early.

The selected text is appended to the relevant user message. It is not injected as a new system policy or passed through every Observer/Settler call. The existing model-call count is unchanged. A known context window reserves the existing prompt and requested output first; remaining capacity can reduce the selection to zero. InkOS's estimator now counts Hangul and kana alongside Han characters instead of using the Latin four-character shortcut for them. It remains a heuristic rather than a provider tokenizer.

Each invocation records an immutable sidecar:

```text
books/<book-id>/story/runtime/author-craft/<chapter>-<stage>-<receipt-sha256>.json
```

The receipt includes pack and configuration identity, query hash, selected and omitted IDs, selection reasons, source IDs, rendered hash, character count, estimated tokens, and the available token budget when known. Different queries that choose the same text still have different receipt identities. The sidecar is evidence of assembled input, not evidence that the model followed it or wrote a better chapter.

`craft history` checks stored receipt identities and rendered hashes, lists the selected metadata, and reports damaged entries without altering them. It does not print the underlying rendered source text. History remains available after disabling the current selection. A valid historical receipt records the input that was assembled; it does not verify today's installed pack or claim a successful model response.

Production admission binds the selected pack and configuration in the existing production-input receipt. A different Book, changed selection, missing selection after admission, changed installed bytes, or incompatible language cannot silently replace the admitted input. With the feature absent, the existing production receipt remains compatible.

## Related Korean context improvements

Korean retrieval recognizes common particles and conjugated query forms and removes only explicitly labelled exclusions. Material excerpts focus on a cluster of relevant terms and carry both UTF-16 offsets and UTF-8 byte offsets with hashes. Those offsets refer to the archived Markdown representation, not necessarily the original PDF or web page.

POV parsing recognizes Korean chapter headings and explicit POV labels. Legacy character-information and hook tables filter exact character columns rather than any incidental name mention. Ambiguous or multiple POVs remain unresolved; this is not a complete reader-knowledge ledger.

Existing entity observations can optionally label a quoted person perspective as belief, desire, intention, experience, or public claim. Exact quotations and dates remain attached. A belief is not promoted to an objective fact. An explicit Writer POV excludes other characters' tagged private perspectives from that projection; untagged historical records retain their prior behavior. Selecting an old belief/desire/intention also prioritizes the latest record for the same named person and category, without declaring the propositions mutually contradictory or merging aliases.

Fact retrieval for chapter N uses evidence available through N−1. When revisiting an older chapter, an exact historical snapshot takes priority; SQLite can otherwise recover earlier validity intervals. Later revelations are excluded using both validity and source chapter. Hook retrieval similarly respects an exact historical snapshot, including an empty one, and excludes later recorded advancements. Planned seeds retain the existing look-ahead policy. This affects the retrieval result; it does not turn every author-facing outline or legacy context file into a character-knowledge filter.

Korean methodology and revision guidance preserve useful interiority, character mistakes, and intentional rhythm. Simple expressions and paragraph regularity remain diagnostic observations rather than proof of AI authorship or automatic creative failure.

## Validation

```sh
pnpm --filter @actalk/inkos-core exec vitest run src/__tests__/author-craft.test.ts src/__tests__/pov-filter.test.ts
pnpm --filter @actalk/inkos-core exec vitest run src/__tests__/entity-observations.test.ts src/__tests__/entity-observations-integration.test.ts src/__tests__/memory-retrieval.test.ts
pnpm --filter @actalk/inkos build
pnpm --filter @actalk/inkos exec vitest run src/__tests__/craft-command-e2e.test.ts
```

The CLI integration test blocks external network calls and uses a temporary Book. Production integration verifies the admitted input and failure before execution on a changed pack. These checks establish input and state behavior; human-reader quality and commercial appeal are not measured by them.
