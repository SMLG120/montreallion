// Plain module (no path aliases / server-only) so Node scripts can import it directly.
import { z } from "zod";

const localized = z.object({ en: z.string().min(5), fr: z.string().min(5) });

export const questionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.enum(["transit", "boroughs", "parks", "food", "history", "festivals", "sports", "universities", "winter", "slang"]),
  scope: z.enum(["city", "island", "agglomeration", "greater", "province"]),
  prompt: localized,
  eligibility: localized,
  verification: z.enum(["source-checked", "editor-curated"]),
  reviewStatus: z.enum(["draft", "in_review", "approved", "rejected"]),
  /** Editorial difficulty of the knowledge asked for; independent of answer rarity. */
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  sources: z.array(z.object({ title: z.string(), url: z.url(), license: z.string(), retrieved: z.string() })).min(1),
  ambiguous: z.array(z.string()).optional(),
  /** How `est` was derived (e.g. "wikidata-sitelinks"); absent for hand-entered seed questions. */
  estBasis: z.string().optional(),
  /** ETL provenance for generated questions. */
  generator: z.object({ template: z.string(), concept: z.string(), contentHash: z.string() }).optional(),
  answers: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]+$/),
        en: z.string().min(1),
        fr: z.string().min(1).optional(),
        aliases: z.array(z.string()),
        est: z.number().int().min(1).max(100),
        refs: z.array(z.string()).optional(),
      }),
    )
    .min(2),
});

export const bankFileSchema = z.object({ version: z.string(), rarityModel: z.string(), questions: z.array(questionSchema) });
