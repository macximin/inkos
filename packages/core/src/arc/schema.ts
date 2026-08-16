import { z } from "zod";

export const ArcStatusSchema = z.enum(["draft", "ready", "completed"]);
export type ArcStatus = z.infer<typeof ArcStatusSchema>;
export const ArcIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);

export const ArcEpisodeRoleSchema = z.enum(["promise", "pressure", "turn", "payoff"]);
export type ArcEpisodeRole = z.infer<typeof ArcEpisodeRoleSchema>;

export const ArcEpisodeBeatSchema = z.object({
  chapterNumber: z.number().int().min(1),
  role: ArcEpisodeRoleSchema,
  beats: z.array(z.string().min(1)).min(1),
  endingHook: z.string(),
});
export type ArcEpisodeBeat = z.infer<typeof ArcEpisodeBeatSchema>;

export const ArcPacketSchema = z.object({
  version: z.literal(1),
  id: ArcIdSchema,
  bookId: z.string().min(1),
  title: z.string().min(1),
  status: ArcStatusSchema,
  episodeCount: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  chapterNumbers: z.array(z.number().int().min(1)).min(1).max(3),
  openingState: z.string(),
  promise: z.string().min(1),
  goal: z.string().min(1),
  obstacle: z.string(),
  pressure: z.string(),
  turn: z.string(),
  payoff: z.string(),
  irreversibleChange: z.string(),
  nextHook: z.string(),
  episodeBeats: z.array(ArcEpisodeBeatSchema).min(1).max(3),
  characterChanges: z.array(z.string()),
  relationshipChanges: z.array(z.string()),
  worldChanges: z.array(z.string()),
  hookOperations: z.array(z.string()),
  mustKeep: z.array(z.string()),
  mustAvoid: z.array(z.string()),
  styleEmphasis: z.array(z.string()),
  sourceForecast: z.object({
    forecastId: z.string().min(1),
    branchId: z.string().min(1),
  }).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).superRefine((arc, ctx) => {
  if (arc.chapterNumbers.length !== arc.episodeCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["chapterNumbers"], message: "chapterNumbers must contain exactly episodeCount entries" });
  }
  if (arc.episodeBeats.length !== arc.episodeCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["episodeBeats"], message: "episodeBeats must contain exactly episodeCount entries" });
  }
  if (
    new Set(arc.chapterNumbers).size !== arc.chapterNumbers.length
    || arc.chapterNumbers.some((chapter, index) => index > 0 && chapter !== arc.chapterNumbers[index - 1]! + 1)
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["chapterNumbers"], message: "Arc chapters must be unique consecutive chapter numbers" });
  }
  const beatChapters = arc.episodeBeats.map((beat) => beat.chapterNumber);
  if (beatChapters.some((chapter, index) => chapter !== arc.chapterNumbers[index])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["episodeBeats"], message: "episodeBeats must align with chapterNumbers in order" });
  }
});
export type ArcPacket = z.infer<typeof ArcPacketSchema>;

export const ActiveArcSchema = z.object({
  arcId: ArcIdSchema,
  updatedAt: z.string().datetime(),
});
export type ActiveArc = z.infer<typeof ActiveArcSchema>;
