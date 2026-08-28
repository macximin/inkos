import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  FireflySurfaceProvenanceBridgeReceiptV1Schema,
  assertFireflySurfaceProvenanceBridgeReceiptV1Identity,
  bridgeExactTokenSurfaceMatchV2,
} from "../storyyard/surface-selector-bridge.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const tokens = "주인공 계약 지분 현금 회장 이사회 반대 증거 인수 발표 승리 보상";

function byteSpan(value: string, selected: string, occurrence = 0) {
  let start = -1;
  let cursor = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    start = value.indexOf(selected, cursor);
    cursor = start + 1;
  }
  const startByte = Buffer.byteLength(value.slice(0, start));
  return {
    coordinateKind: "utf8-byte" as const,
    startByte,
    endByte: startByte + Buffer.byteLength(selected),
    sliceSha256: sha256(selected),
  };
}

describe("Storyyard surface selector provenance bridge", () => {
  it("converts a verified story UTF-16 range into bound UTF-8 selectors", () => {
    const prose = `도입 😀 ${tokens} 끝`;
    const chapter = `제1화\n${prose}`;
    const sourceText = `머리말 😀\n${chapter}\n다음 화`;
    const rangeStart = sourceText.indexOf(chapter);
    const candidateContent = `후보 😀 ${tokens} 후속`;
    const { match, receipt } = bridgeExactTokenSurfaceMatchV2({
      candidateContent,
      candidateContentSha256: sha256(candidateContent),
      sourceId: "gdrive-story-one",
      sourceText,
      sourceSha256: sha256(sourceText),
      exactMatch: { tokenCount: 12, text: tokens },
      provenance: {
        kind: "story-index-utf16",
        provenanceId: "chapter-1",
        sourceCharacterRange: { start: rangeStart, end: rangeStart + chapter.length },
        rawProseSha256: sha256(prose),
      },
    });
    expect(FireflySurfaceProvenanceBridgeReceiptV1Schema.parse(receipt)).toEqual(receipt);
    expect(receipt.provenance.mappingMode).toBe("range-validated");
    expect(match.source.startByte).toBeGreaterThan(sourceText.indexOf(tokens));
    expect(match.candidate.startByte).toBeGreaterThan(candidateContent.indexOf(tokens));
    expect(match.provenanceBridgeReceiptSha256).toBe(receipt.receiptSha256);
    expect(() => assertFireflySurfaceProvenanceBridgeReceiptV1Identity({
      ...receipt,
      sourceId: "gdrive-tampered",
    })).toThrow(/identity or SHA-256 mismatch/u);
  });

  it("reverse maps one range-less style example and rejects ambiguous prose", () => {
    const styleProse = `문체 예시 ${tokens} 종결`;
    const candidateContent = `후보 ${tokens} 후속`;
    const uniqueSource = `앞\n${styleProse}\n뒤`;
    const unique = bridgeExactTokenSurfaceMatchV2({
      candidateContent,
      candidateContentSha256: sha256(candidateContent),
      sourceId: "gdrive-style-one",
      sourceText: uniqueSource,
      sourceSha256: sha256(uniqueSource),
      exactMatch: { tokenCount: 12, text: tokens },
      provenance: {
        kind: "style-example-prose",
        provenanceId: "style-1",
        rawProseSha256: sha256(styleProse),
        prose: styleProse,
      },
    });
    expect(unique.receipt.provenance.mappingMode).toBe("unique-exact-reverse-map");

    const duplicateSource = `${styleProse}\n중간\n${styleProse}`;
    const duplicateInput = {
      candidateContent,
      candidateContentSha256: sha256(candidateContent),
      sourceId: "gdrive-style-two",
      sourceText: duplicateSource,
      sourceSha256: sha256(duplicateSource),
      exactMatch: { tokenCount: 12, text: tokens },
      provenance: {
        kind: "style-example-prose" as const,
        provenanceId: "style-2",
        rawProseSha256: sha256(styleProse),
        prose: styleProse,
      },
    };
    expect(() => bridgeExactTokenSurfaceMatchV2(duplicateInput)).toThrow(/exactly once or carry an imported/u);
    const imported = bridgeExactTokenSurfaceMatchV2({
      ...duplicateInput,
      provenance: { ...duplicateInput.provenance, importedSourceSelector: byteSpan(duplicateSource, styleProse, 1) },
    });
    expect(imported.receipt.provenance.mappingMode).toBe("imported-utf8-selector");
    expect(imported.receipt.provenance.importedSelectorSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("fails closed on source, prose, UTF boundary, and token ambiguity drift", () => {
    const prose = `😀\n${tokens}`;
    const sourceText = `앞${prose}뒤`;
    const candidateContent = `후보 ${tokens}`;
    const base = {
      candidateContent,
      candidateContentSha256: sha256(candidateContent),
      sourceId: "gdrive-fail",
      sourceText,
      sourceSha256: sha256(sourceText),
      exactMatch: { tokenCount: 12, text: tokens },
      provenance: {
        kind: "story-index-utf16" as const,
        provenanceId: "chapter-fail",
        sourceCharacterRange: { start: 1, end: sourceText.length - 1 },
        rawProseSha256: sha256(tokens),
      },
    };
    expect(() => bridgeExactTokenSurfaceMatchV2({ ...base, sourceSha256: sha256("drift") })).toThrow(/source SHA-256 mismatch/u);
    expect(() => bridgeExactTokenSurfaceMatchV2({
      ...base,
      provenance: { ...base.provenance, rawProseSha256: sha256("drift") },
    })).toThrow(/prose SHA-256 mismatch/u);
    expect(() => bridgeExactTokenSurfaceMatchV2({
      ...base,
      provenance: { ...base.provenance, sourceCharacterRange: { start: 2, end: sourceText.length - 1 } },
    })).toThrow(/surrogate pair/u);
    expect(() => bridgeExactTokenSurfaceMatchV2({
      ...base,
      candidateContent: `${candidateContent}\n${tokens}`,
      candidateContentSha256: sha256(`${candidateContent}\n${tokens}`),
    })).toThrow(/Candidate token sequence must resolve exactly once/u);
  });
});
