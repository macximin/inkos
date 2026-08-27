# Korean fiction signal guide

Use deterministic signals to locate passages, then decide from scene function. These checks are conservative and advisory.

## High-confidence residue

- Remove assistant-response wrappers such as an announcement that a requested revision follows.
- Move Markdown lists, multiple editing headings, and code fences outside the manuscript unless the book intentionally uses them as an in-world form.
- Preserve a single chapter-title heading, intentional scene dividers, and the common `- 대사` convention.

## Repetition that requires reading

- Repeated interpretive closures can explain an action, emotion, or victory the scene has already made visible. Delete only the duplicated interpretation; keep necessary causal information.
- Repeated binary contrasts using `아니라` can create generated cadence. Keep contrasts that sharpen the protagonist's strategy or voice. Rewrite only interchangeable restatements.
- A repeated transition, subject opening, or paragraph length is not a defect by itself. Check whether it creates pressure, comedy, ritual, or character voice.

## Commerciality guardrail

Do not clean away:

- an early money, ownership, authority, or status receipt;
- another character's changed form of address or treatment;
- a concrete decision that turns knowledge into action;
- a hook, reversal, humiliation, or payoff because it seems blunt;
- genre-readable rhythm that makes the next episode easy to buy.

Prefer replacing generic explanation with concrete cause, cost, choice, and human reaction. Compare the revised passage with the original before accepting it. If factual meaning, canon, emotional direction, or propulsion changes, send the choice to human review.

The local analyzer is self-contained and has no runtime dependency on external humanizer packages. Its maintenance direction was informed by public Korean clarity and prose-linting projects, but rules should enter InkOS only after Korean-webnovel regression tests demonstrate low false-positive risk.
