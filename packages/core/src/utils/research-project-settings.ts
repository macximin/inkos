import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ResearchSearchConfigSchema,
  type ResearchSearchConfig,
} from "../models/project.js";

export type ResearchProjectLanguage = "zh" | "ko" | "en";

export interface ResearchProjectSettings {
  readonly language: ResearchProjectLanguage;
  readonly search: ResearchSearchConfig;
}

const ResearchProjectSettingsSchema = z.object({
  language: z.enum(["zh", "ko", "en"]).default("zh"),
  researchSearch: ResearchSearchConfigSchema,
});

/**
 * Read only the project settings needed by explicit research. A missing or
 * malformed project file keeps research disabled and falls back to Chinese,
 * matching the historical project default without exposing LLM credentials.
 */
export async function readResearchProjectSettings(
  projectRoot: string,
): Promise<ResearchProjectSettings> {
  try {
    const raw = JSON.parse(await readFile(join(projectRoot, "inkos.json"), "utf-8"));
    const parsed = ResearchProjectSettingsSchema.parse(raw);
    return { language: parsed.language, search: parsed.researchSearch };
  } catch {
    return {
      language: "zh",
      search: ResearchSearchConfigSchema.parse({}),
    };
  }
}
