import type { QuestionDef, Tier } from "./types";

export const MIN_SCORE = 10;
export const MAX_SCORE = 100;

export const TIERS: { id: Tier; min: number; color: string }[] = [
  { id: "legend", min: 90, color: "var(--line-yellow)" },
  { id: "gem", min: 75, color: "var(--line-blue)" },
  { id: "expert", min: 55, color: "var(--line-green)" },
  { id: "regular", min: 35, color: "var(--line-orange)" },
  { id: "tourist", min: 10, color: "var(--line-grey)" },
];

export function tierFor(score: number): Tier {
  return (TIERS.find((t) => score >= t.min) ?? TIERS[TIERS.length - 1]).id;
}

/**
 * Bootstrap rarity model ("estimated-v1"): uses editor-estimated familiarity weights.
 * score = 100 - 90 * (weight / mostFamiliarWeight), so the most familiar answer is
 * worth 10 and an answer nobody is expected to give approaches 100.
 * `share` is the answer's estimated share of all correct answers (for display).
 */
export function rarityScore(q: QuestionDef, answerId: string): { score: number; share: number; tier: Tier } {
  const a = q.answers.find((x) => x.id === answerId);
  if (!a) throw new Error(`Unknown answer ${answerId} for ${q.id}`);
  const max = Math.max(...q.answers.map((x) => x.est));
  const total = q.answers.reduce((s, x) => s + x.est, 0);
  const raw = MAX_SCORE - (MAX_SCORE - MIN_SCORE) * (a.est / max);
  const score = Math.min(MAX_SCORE, Math.max(MIN_SCORE, Math.round(raw)));
  return { score, share: a.est / total, tier: tierFor(score) };
}

/* ------------------------------------------------------------------ observed-v1 */

/** Model id for databases with play statistics; per question it falls back to the estimate until there's enough data. */
export const OBSERVED_MODEL = "observed-v1";
/** Distinct correct-answer players a question needs before observed frequencies are used. */
export const MIN_SAMPLE = 30;
/** Weight (in pseudo-players) of the estimate when blending with observed counts (additive smoothing). */
export const PRIOR_WEIGHT = 20;

/** Distinct players who gave each answer (slug → players); n = sum over answers. */
export type AnswerCounts = { n: number; bySlug: Record<string, number> };
export type RarityBasis = "estimated" | "observed";
export type Rarity = { score: number; share: number; tier: Tier; basis: RarityBasis; n: number };

/**
 * Scores every answer of a question.
 * - n < MIN_SAMPLE → exactly estimated-v1 (basis "estimated").
 * - otherwise → share_a = (c_a + K·p_a) / (n + K), where p_a is the estimated share and K = PRIOR_WEIGHT,
 *   then score = 100 − 90 · share_a / max share (same shape as estimated-v1, so the scale is stable).
 * Smoothing keeps never-seen answers below 100 only relative to the estimate, and one player can
 * move a share by at most 1/(n+K).
 */
export function rarityTable(q: QuestionDef, counts?: AnswerCounts | null): Record<string, Rarity> {
  const totalEst = q.answers.reduce((s, x) => s + x.est, 0);
  const observed = !!counts && counts.n >= MIN_SAMPLE;
  const shares = q.answers.map((a) => {
    const prior = a.est / totalEst;
    return observed ? ((counts!.bySlug[a.id] ?? 0) + PRIOR_WEIGHT * prior) / (counts!.n + PRIOR_WEIGHT) : prior;
  });
  const max = Math.max(...shares);
  const out: Record<string, Rarity> = {};
  q.answers.forEach((a, i) => {
    const score = Math.min(MAX_SCORE, Math.max(MIN_SCORE, Math.round(MAX_SCORE - (MAX_SCORE - MIN_SCORE) * (shares[i] / max))));
    out[a.id] = { score, share: shares[i], tier: tierFor(score), basis: observed ? "observed" : "estimated", n: counts?.n ?? 0 };
  });
  return out;
}
