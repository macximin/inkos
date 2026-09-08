import { z } from "zod";

/** New Firefly execution uses Astra; immutable Sol evidence remains readable. */
export const FIREFLY_PRODUCTION_MODEL = "gpt-6-astra";
export const FIREFLY_PRODUCTION_REASONING = "high";
export const FireflyRuntimeModelSchema = z.enum(["gpt-5.6-sol", "gpt-6-astra"]);
export type FireflyRuntimeModel = z.infer<typeof FireflyRuntimeModelSchema>;
