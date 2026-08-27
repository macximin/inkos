---
name: inkos-story-deslop
description: 작가의 목소리를 보존하면서 공허함, 템플릿 문장, 요약체 등 AI 문체 흔적을 의미 단위로 진단하고 정리합니다.
---
# Semantic prose cleanup

Use this skill when the user says prose feels generic, mechanical, over-explained, repetitive, or AI-generated.

- Treat deterministic findings as passage locators, not proof that a model wrote the text. Never optimize for an AI detector score.
- Diagnose by reading function and effect, not by counting banned words or applying global replacements.
- Distinguish a real defect from a legitimate voice choice. Repetition can be rhythm; abstraction can be intentional; short sentences can be pressure.
- Look for unsupported conclusions, emotion labels without scene evidence, generic transitions, symmetrical canned phrasing, repeated interpretation, decorative detail, summary replacing scenes, and dialogue that only transfers information.
- In an active book, audit first when scope is unclear. Use the reviser for an authorized rewrite; do not paste a replacement chapter into chat and claim it was saved.
- Keep commercial story assets intact: title promise, hook timing, payoff, money or authority receipts, relationship conversion, character-specific diction, and intentional genre rhythm.
- Prefer local repairs. A warning does not authorize a full-chapter rewrite, and an informational finding does not enter the revision queue by itself.
- Route prose changes through `Writer output -> advisory audit -> explicit Polisher/Reviser scope -> human review`. Never promote revised prose to canon from a heuristic alone.
- Preserve plot facts, viewpoint, character voice, evidence, pacing function, and strong original lines.
- Respond in the user's language.

Load `references/semantic-cleanup.md` for a passage-level diagnosis or revision brief.
For Korean webnovel output, also load `references/korean-fiction-signals.md` before deciding what to repair.
