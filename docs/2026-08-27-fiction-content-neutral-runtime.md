# Fiction-content-neutral runtime contract

Status: implemented on 2026-08-27 and P2 follow-up completed on 2026-08-28; no reproducible P0/P1 remains in the bounded audit.

## Product decision

InkOS optimizes private-fiction production for reader interest, dopamine, emotional causality, and commercial execution. It does not treat fictional crime, violence, exploitation, betrayal, prejudice, immorality, offensiveness, or an unjust outcome as a creative defect by itself.

The runtime must not add or remove condemnation, apology, punishment, remorse, rehabilitation, redemption, moral growth, or a moral cost solely to make a story more acceptable. Any of those beats remain valid when they arise from established character desire and scene causality, or when the owner has explicitly authorized them.

This does not relax real-world repository authority, private-source access, personal-data handling, provider restrictions, or publication-platform requirements.

## Runtime boundaries

### Creative review

- Automatic prose repair is limited to deterministic host validators that explicitly set `automaticRevisionEligible: true`. Free-form LLM findings never acquire that bit, including findings that quote a provenance-verified hard rule.
- LLM audit findings remain diagnostic/HIL candidates. A verified hard-rule quote proves that the rule is authoritative, not that a natural-language allegation correctly proves its predicate; it therefore remains manual until a deterministic validator exists.
- Dimension 14 (side-character agency) is advisory at most when it comes from free-form review. An exact quote proves only that source bytes exist, not logical incompatibility. A provenance-verified hard BookRule may remain critical for human review but still cannot authorize automatic mutation.
- Dimension 27 is publication metadata only. It cannot fail creative review or be relabeled into a structural dimension by policy-shaped wording.
- A moral, representation, sensitivity, or platform objection is content-neutralized and cannot become a revision candidate solely on that basis.
- A concrete causal consequence remains actionable. Example: a witnessed murder may create a continuity problem when an already-established police/evidence system disappears without explanation; the crime or lack of punishment itself is not the problem.
- Foundation-review scores and feedback are diagnostic/HIL-only and never trigger automatic regeneration. A structurally complete response may continue regardless of score; malformed or missing dimensions fail closed before a new foundation is promoted, preserving an existing canon.
- Architect output is scanned for unauthorized mandatory moral or PC correction before promotion. The scan normalizes wrapped Unicode whitespace and common markup, catches obligation/inevitability aliases in Korean, English, and Chinese, and covers model-invented condemnation, punishment, repentance/redemption, moral-balance, normalization/glorification, safer-alternative, representation, protected-group, positive-portrayal, agency, stereotype/offensiveness, and gender-balance quotas. It still permits concrete causal events such as an evidence-backed arrest or court judgment. Exact owner/foundation/hard-rule authority remains quote- and negation-aware.
- Direct representation quotas and protected-character portrayal mandates are rejected in English, Korean, and Chinese when they lack exact authority. Conditional, hypothetical, alleged, reviewer-attributed, draft-attributed, and reportedly/supposedly adopted text cannot impersonate owner adoption. Unqualified owner adoption remains valid, while fictionally attributed dialogue and ordinary commercial events remain creative material rather than policy instructions.
- Planner `Do not` entries are host-validated planning inputs rather than a place where the model can mint new hard rules. Unauthorized mandatory correction triggers bounded re-planning and then a neutral fallback; Writer repeats the authority check so a persisted or directly supplied memo cannot bypass Planner.
- Settler runtime-state deltas are checked before projection. A model-created current-state, hook, summary, subplot, emotional-arc, or character-matrix mandate cannot become L1 canon unless the same requirement is grounded in explicit owner input, Architect-clean foundation canon, the Chapter body, or a verified hard rule. Runtime projections and prior prose do not themselves become moral-rule authority for a later memo.

### Publication compatibility

- Sensitive-term scanning emits a distinct `publication-compatibility` result with `block|warn` vocabulary.
- It is excluded from creative pass/fail, commercial score, canon, and automatic revision.
- CLI and Studio surface it as advisory metadata and state that the manuscript was not automatically changed.

### BookRules provenance

- `story/book_rules.md` remains the raw human-readable display surface.
- `story/book_rules.provenance.json` is the host-owned enforcement sidecar.
- Model-created restrictions default to diagnostic.
- A hard rule requires an exact rule selector plus either an exact source-authority receipt or an owner-adoption receipt.
- A source-authority receipt and its sidecar reference bind an authenticated authority origin, `authorize-rule` intent, stable human decision ID, actor, exact source selector, and rule identity into their hashes.
- The host re-reads and hashes the actual source artifact and receipt before allowing automatic action.
- Missing, invalid, stale, partial, or tampered provenance yields hard-rule count zero while preserving raw display.
- Architect writes `book_rules.md` and its provenance sidecar as an atomic pair. Exact verified rules alone may carry forward through an architecture revision.
- Free-form create instructions, external context, reviewer text, and foundation-revision feedback never become source authority by themselves, even after a general production confirmation. Studio now exposes a separate, user-visible typed `hardRules[]` adoption control on the direct creation form. Only checked, non-empty rows are sent with a distinct confirmation bit; the host validates the collection/text/decision tuple, creates the decision ID and local owner actor identity, writes the exact rule into the normalized BookRules surface, and binds an immutable owner-adoption receipt. Ordinary briefs still pass no source authority.
- Studio exposes the raw BookRules document as read-only diagnostic text and refuses direct PUT edits, directing future hard-rule adoption through the provenance path.

### Model-call contract and intensity

- Every Book-bound `BaseAgent` call receives the host-owned fiction-content-neutral contract, including native web-search calls.
- Direct style-guide, canon-import, and narrative-forecast model paths use the same boundary.
- The default content-intensity directive is `preserve`.
- Any non-default intensity directive requires exact source bytes, selector hashes, and a matching decision receipt.
- Attempt, request, and outcome evidence is immutable. Provider refusal/failure is recorded and may not be promoted into Book canon.
- Terminal provider `error`, `aborted`, token-length truncation, content filtering, malformed or unhandled tool-use, and protocol mismatch fail the request across Anthropic, OpenAI Chat, OpenAI Responses, and pi-ai transports. Explicit high-confidence English, Korean, or Chinese provider-refusal boilerplate—including a refusal hidden inside a marker-conformant Chapter body—also becomes a dedicated error instead of usable prose; fictionally attributed dialogue and narration remain valid. An incomplete mutation tool call is normalized to an error before the agent runtime can execute it.
- Chapter persistence requires an operation-scoped manifest that binds the exact current invocation IDs and required stages. Historical failed evidence is retained but does not poison an unrelated later operation.
- Draft, full-write, manual-revision, state-repair, manually edited Chapter resync, and each imported Chapter run inside a Book-locked logical transaction. Before any logical mutation, a durable Book-local journal records the exact pre-operation bytes and a prepared marker. Success installs a durable committed marker before cleanup; a caught failure restores the prior Chapter, truth projections, index/current metadata, Book status, state snapshots, revision archive, memory files, and per-Chapter truth receipt before the error escapes. On the next Book-lock acquisition, lower-level atomic file sets recover first and the outer Chapter journal then either restores a prepared operation or removes a committed journal without reverting it. Multi-Chapter import keeps already committed earlier Chapters as intentional resume points while rolling back the failing Chapter atomically.
- Fanfic, spinoff, and imitation initialization build in a staging Book and expose the canonical Book with one rename only after required evidence and files validate. Failure moves staging evidence to quarantine and never overwrites a pre-existing Book.
- Narrative forecast persistence uses temp-file replacement so interrupted writes do not expose partial JSON.

## Deliberate compatibility choices

- Raw `readBookRules()` remains available for display and legacy inspection.
- Production prompts and validators consume the verified projection, never the raw BookRules body.
- Non-restriction canon facts remain available; enforcement-sensitive arrays are reduced to verified hard entries.
- Free-form model-generated audit dimensions do not become automatic gates.
- Manual revision comparison uses host-owned deterministic checks, while automatic repair uses only findings carrying the explicit automatic-action bit. Subjective LLM findings remain visible for HIL but cannot steer or veto an explicit owner edit.
- Existing legacy Books are not silently rewritten. Without a sidecar, their restriction candidates are diagnostic until explicit adoption or exact-source authorization.

## P2 follow-up closed on 2026-08-28

- Studio direct creation has a typed, separately checked `hardRules[]` owner-decision ingress. The browser never supplies receipt identity: the host creates the stable decision ID and actor binding, and Core proves the rule with exact selector plus immutable owner-adoption receipt before it becomes hard.
- Continuity now creates a read-time-only projection of legacy `current_state`. Markdown records are grouped before scanning so wrapped mandates cannot split obligation from target. Unauthorized moral/representation control records are withheld from the diagnostic/HIL prompt while commercial facts and clearly attributed fictional speech remain available; the canonical file is not rewritten.
- Chapter persistence now has a durable outer journal and Book-lock recovery hook. Prepared journals restore byte-exact pre-operation state, committed journals retain post-operation state, unknown phases and multiple abandoned journals fail closed with evidence preserved, and normal success/error paths leave no journal behind.

## Bounded residual risks

- Content-neutralization is deliberately pattern-based. A novel paraphrase that escapes recognition may still create diagnostic/HIL noise, but free-form LLM findings cannot authorize automatic mutation and the source file remains unchanged.
- Foundation-dependent hard-rule collections (`protagonist`, `genreLock`, and `futureAdvantage`) fail closed if the generated foundation does not contain the required typed container. `prohibitions` is always available; Studio does not yet pre-compute container availability before creation.
- Recovery assumes the Book lock remains the sole write serializer. More than one abandoned outer Chapter journal is treated as corruption requiring inspection rather than guessed recovery order.

## Verification checklist

- [x] Core typecheck
- [x] Focused provenance, content-neutrality, publication, forecast, and operation-receipt tests
- [x] Full Core test suite
- [x] Core build
- [x] CLI typecheck/test for advisory rendering
- [x] Studio typecheck/test for advisory rendering
- [x] `git diff --check`
- [x] Independent P0/P1 adversarial audit
- [x] HQ/InkOS Git boundary and dirty-tree readback

## Verification receipt

- Core: 212 test files, 2,416 tests passed.
- CLI: 46 test files, 251 tests passed, including build and publish-package checks.
- Studio: 61 test files, 650 tests passed.
- Full workspace `typecheck` and `build` passed for Core, CLI, and Studio.
- `audit:semantic-patterns`, `verify:publish-manifests`, and `git diff --check` passed.
- P2 follow-up probes passed 153 focused Core tests plus 28 focused Studio API/page-state tests for wrapped legacy-state contamination, owner-decision request propagation and exact receipt projection, caught rollback, abandoned prepared-journal restart recovery, committed-journal preservation, unknown-phase fail-closed behavior, and lower-level atomic recovery compatibility.
- The bounded current-tree audit found no reproducible P0/P1 in these three follow-up surfaces.
- The repository root defines `lint` as a recursive delegation, but none of the three packages defines a `lint` script. `pnpm -r lint` therefore reports `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`; no lint pass is claimed.
- No commit or push was performed for this goal.
