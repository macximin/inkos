import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  PitchVariationRequestSchema, PitchVariationCandidateSchema, PitchVariationReviewSchema,
  FireflyVariationReviewPacketV5Schema, VariationProjectPlanSchema,
  buildVariationReviewPacket, variationHash, sourceFactRepairHash,
} from "../packages/core/dist/index.js";

const [preparedArg, authoredArg, outputArg] = process.argv.slice(2);
if (!preparedArg || !authoredArg || !outputArg) throw new Error("Usage: prepared-directory authored-directory new-output-directory");
const prepared = resolve(preparedArg), authored = resolve(authoredArg), output = resolve(outputArg);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const request = PitchVariationRequestSchema.parse(await json(join(prepared, "request.json")));
const packet = FireflyVariationReviewPacketV5Schema.parse(await json(join(prepared, "storyyard-packet.json")));
const review = PitchVariationReviewSchema.parse(await json(join(prepared, "review.json")));
const candidates = await Promise.all(packet.candidates.map(async (candidate) => {
  const value = PitchVariationCandidateSchema.parse(await json(join(prepared, `${candidate.id}.json`)));
  const receipt = await json(join(prepared, `${candidate.id}-receipt.json`));
  if (receipt.requestSha256 !== variationHash(request) || receipt.candidateSha256 !== variationHash(value)) throw new Error("Candidate receipt changed.");
  return value;
}));
if (variationHash(buildVariationReviewPacket(request, candidates, review, packet.generatedAt)) !== variationHash(packet)) throw new Error("Existing packet differs from the verified candidates and review.");
const plans = await Promise.all(packet.candidates.map(async (candidate) => {
  const markdown = await readFile(join(authored, `${candidate.id}.md`), "utf8");
  const projectPlan = VariationProjectPlanSchema.parse({ format: "webnovel-project-plan/v1", markdown });
  return { candidateId: candidate.id, candidateSha256: candidate.sha256, projectPlan, projectPlanSha256: sourceFactRepairHash(projectPlan.markdown) };
}));
const unsigned = { schemaVersion: "inkos-variation-project-plans/v1", sourceSystem: "inkos", packetId: packet.packetId, packetSha256: packet.packetSha256,
  generatedAt: new Date().toISOString(), basis: "existing-candidates-and-owner-format-request", plans };
const document = { ...unsigned, sha256: variationHash(unsigned) };
await mkdir(output, { recursive: false, mode: 0o700 });
await writeFile(join(output, "project-plans.json"), JSON.stringify(document, null, 2) + "\n", { flag: "wx", mode: 0o600 });
for (const plan of plans) await writeFile(join(output, `${plan.candidateId}.md`), plan.projectPlan.markdown, { flag: "wx", mode: 0o600 });
await writeFile(join(output, "receipt.json"), JSON.stringify({ kind: "existing-variation-plan-formatting/v1", packetId: packet.packetId, packetSha256: packet.packetSha256,
  requestSha256: variationHash(request), candidatesSha256: variationHash(candidates), reviewSha256: variationHash(review), documentSha256: document.sha256,
  authoredDirectory: authored, evidenceSha256: sourceFactRepairHash(await readFile(join(authored, "evidence.json"))),
  newModelCalls: 0, originalCandidatesChanged: false, originalReviewChanged: false, decisionEffect: "unchanged-variation-selection", formattedAt: document.generatedAt }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
process.stdout.write(JSON.stringify({ output, packetId: document.packetId, candidates: plans.length, documentSha256: document.sha256 }) + "\n");
