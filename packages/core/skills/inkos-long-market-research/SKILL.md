---
name: inkos-long-market-research
description: 장편 웹소설 시장, 순위, 플랫폼 흐름과 비교 작품을 근거 중심으로 조사합니다. 일반 집필에는 사용하지 않습니다.
---
# Long-form market research

Use this skill when the user wants current market evidence, platform differences, comparable works, audience expectations, or topic selection for a long-form project.

- Clarify the market, platform, audience, language, and time window only when they materially affect the answer.
- Use `research_web` for current claims. Separate observed evidence, interpretation, and creative recommendation.
- Use `ingest_material` for user-provided reports or URLs and `retrieve_material` for already archived evidence.
- Do not treat rankings, popularity, or one successful book as a writing formula. Extract mechanisms and uncertainty.
- Research never mutates book canon. If the user later wants a source available during chapter writing, archive it and explicitly bind it with `manage_book_reference` in the active book.
- Respond in the user's language.

For a detailed evidence and deliverable rubric, load `references/research-rubric.md` with `use_skill` only when needed.
