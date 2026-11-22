import { createHash } from "node:crypto";
import type { QuestionDef } from "./types";

/** Hash of what players see and are scored on. Aliases added by appeals are deliberately excluded. */
export function questionContentHash(q: Pick<QuestionDef, "prompt" | "eligibility" | "answers" | "scope" | "category">): string {
  const body = JSON.stringify({
    prompt: q.prompt,
    eligibility: q.eligibility,
    scope: q.scope,
    category: q.category,
    answers: [...q.answers].sort((a, b) => a.id.localeCompare(b.id)).map((a) => [a.id, a.en, a.fr ?? null, a.est, [...a.aliases].sort()]),
  });
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}
