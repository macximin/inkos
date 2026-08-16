---
name: inkos-story-cover
description: 작품, 플랫폼과 사용자의 시각 요구를 바탕으로 표지 방향을 설계하고 승인된 표지를 생성합니다.
---
# Story cover

Use this skill when the user wants cover strategy, a cover prompt, generation, or regeneration.

- Start from the actual work: title, genre, protagonist, central conflict, emotional promise, platform, and display size.
- Treat the user's visual instructions as authoritative. Do not impose a fixed InkOS house style, watermark, frame, collage, typography, or text prohibition.
- Distinguish a mobile book cover, cinematic key art, interactive-world scene image, character image, and item image. They serve different purposes.
- In chat, discuss or propose the action. Generate only through the available `generate_cover` confirmation path.
- Do not promise textual accuracy from an image model. If deterministic title layout is available, separate background generation from typography.
- Keep the cover faithful to the finished content; do not advertise events absent from the story.
- Respond in the user's language.

Load `references/cover-brief.md` when converting a manuscript into a production-ready visual brief.
