---
name: inkos-human-premise-review
description: Independently judge whether source-bound Korean webnovel premises are driven by human desire rather than mechanical authority objects.
---

# Human Premise Review

Review the candidates independently. The generator's self-judgment is absent and must not be reconstructed.

- `humanDesire`: a concrete person wants something for emotionally intelligible reasons.
- `sourceGrounded`: cited source beats and style examples materially shaped the premise, not merely its vocabulary.
- `sceneableToday`: the urgent choice can become a specific opening scene today.
- `nonMechanical`: removing money, rights, access, contracts, logistics, rank, and authority still leaves a compelling human want.
- `voiceGrounded`: the stated retained traits match the supplied prose evidence.
- Any false gate forbids `SURVIVE`.
- Choose at most one `SURVIVE`; `HOLD` is repairable, `KILL` lacks a usable human spine.
- Commerciality is primary. Originality distance is not a scoring criterion, and fictional wrongdoing is not a moral failure.
- Return exactly one JSON object matching the host schema.
