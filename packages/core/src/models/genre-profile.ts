import { z } from "zod";
import yaml from "js-yaml";

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const GenreProfileSchema = z.object({
  name: z.string(),
  id: z.string(),
  language: z.enum(["zh", "ko", "en"]).default("zh"),
  chapterTypes: z.array(z.string()),
  fatigueWords: z.array(z.string()),
  numericalSystem: z.boolean().default(false),
  powerScaling: z.boolean().default(false),
  eraResearch: z.boolean().default(false),
  pacingRule: z.string().default(""),
  satisfactionTypes: z.array(z.string()).default([]),
  auditDimensions: z.array(z.number()).default([]),
});

export type GenreProfile = z.infer<typeof GenreProfileSchema>;

export interface ParsedGenreProfile {
  readonly profile: GenreProfile;
  readonly body: string;
}

export const GenreProfileReadReceiptSchema = z.object({
  schemaVersion: z.literal("genre-profile-read-receipt/v1"),
  requestedGenre: z.string().trim().min(1).max(240),
  resolvedProfileId: z.string().trim().min(1).max(240),
  source: z.enum(["project", "builtin"]),
  profilePath: z.string().trim().min(1),
  profileSha256: Sha256HexSchema,
  profileSizeBytes: z.number().int().positive(),
  language: z.enum(["zh", "ko", "en"]),
}).strict();
export type GenreProfileReadReceipt = z.infer<typeof GenreProfileReadReceiptSchema>;

export interface ResolvedGenreProfile extends ParsedGenreProfile {
  readonly receipt: GenreProfileReadReceipt;
}

export function parseGenreProfile(raw: string): ParsedGenreProfile {
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error("Genre profile missing YAML frontmatter (--- ... ---)");
  }

  const frontmatter = yaml.load(fmMatch[1]) as Record<string, unknown>;
  const profile = GenreProfileSchema.parse(frontmatter);
  const body = fmMatch[2].trim();

  return { profile, body };
}
