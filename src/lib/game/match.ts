import { editDistance, normalizeAnswer, normalizeWords, typoBudget } from "./normalize";
import type { QuestionDef } from "./types";

export type MatchResult =
  | { kind: "match"; answerId: string; by: "exact" | "fuzzy" }
  | { kind: "ambiguous" }
  | { kind: "none" };

type Index = { keys: Map<string, Set<string>>; ambiguous: Set<string> };
const cache = new WeakMap<QuestionDef, Index>();

export function answerKeys(a: QuestionDef["answers"][number]): string[] {
  const forms = [a.en, a.fr, ...a.aliases].filter((x): x is string => !!x);
  return [...new Set(forms.map(normalizeAnswer).filter(Boolean))];
}

function indexFor(q: QuestionDef): Index {
  let idx = cache.get(q);
  if (idx) return idx;
  const keys = new Map<string, Set<string>>();
  for (const a of q.answers) {
    for (const k of answerKeys(a)) {
      if (!keys.has(k)) keys.set(k, new Set());
      keys.get(k)!.add(a.id);
    }
  }
  idx = { keys, ambiguous: new Set((q.ambiguous ?? []).map(normalizeAnswer)) };
  cache.set(q, idx);
  return idx;
}

/**
 * Server-side validation against the question's eligible-answer set.
 * Exact key match first; then a conservative typo match that is rejected
 * if more than one distinct answer is equally close.
 */
export function matchAnswer(q: QuestionDef, raw: string): MatchResult {
  const input = normalizeAnswer(raw.slice(0, 120));
  if (!input) return { kind: "none" };
  const idx = indexFor(q);

  if (idx.ambiguous.has(input)) return { kind: "ambiguous" };

  const exact = idx.keys.get(input);
  if (exact) {
    return exact.size === 1 ? { kind: "match", answerId: [...exact][0], by: "exact" } : { kind: "ambiguous" };
  }

  const budget = typoBudget(input.length);
  if (budget === 0) return { kind: "none" };

  let best = budget + 1;
  let bestIds = new Set<string>();
  for (const [key, ids] of idx.keys) {
    const keyBudget = Math.min(budget, typoBudget(key.length));
    if (keyBudget === 0) continue; // never fuzzy-match onto short keys
    const d = editDistance(input, key, keyBudget);
    if (d > keyBudget) continue;
    if (d < best) {
      best = d;
      bestIds = new Set(ids);
    } else if (d === best) {
      ids.forEach((id) => bestIds.add(id));
    }
  }
  if (best > budget || bestIds.size === 0) return { kind: "none" };
  if (bestIds.size > 1) return { kind: "ambiguous" };
  return { kind: "match", answerId: [...bestIds][0], by: "fuzzy" };
}

/** Most candidates a pre-check will ever show; more than this is "too vague" and shows none. */
export const MAX_CANDIDATES = 4;

export type CheckResult =
  /** One entity, exact key (label or alias). */
  | { kind: "match"; answerIds: [string]; by: "exact" }
  /** Typo-corrected and/or several entities: the player must pick one. */
  | { kind: "possible"; answerIds: string[]; by: "exact" | "fuzzy" }
  /** Fits too many answers to list without leaking the catalog. */
  | { kind: "vague" }
  | { kind: "none" };

/**
 * Pre-submission double-check. Deterministic and bounded: it only ever returns
 * answers within the same conservative typo budget as `matchAnswer` (or, for a
 * listed ambiguous input like "Richard", the few answers containing it as whole
 * words), never prefix/autocomplete results, and never more than MAX_CANDIDATES.
 */
export function checkAnswer(q: QuestionDef, raw: string): CheckResult {
  const input = normalizeAnswer(raw.slice(0, 120));
  if (!input) return { kind: "none" };
  const idx = indexFor(q);
  const bounded = (ids: Iterable<string>, by: "exact" | "fuzzy"): CheckResult => {
    const list = q.answers.map((a) => a.id).filter((id) => new Set(ids).has(id)); // stable bank order
    if (list.length === 0) return { kind: "none" };
    if (list.length > MAX_CANDIDATES) return { kind: "vague" };
    return { kind: "possible", answerIds: list, by };
  };

  if (idx.ambiguous.has(input)) {
    const ids = new Set<string>();
    for (const a of q.answers) {
      for (const form of [a.en, a.fr, ...a.aliases].filter((x): x is string => !!x)) {
        const words = normalizeWords(form).split(" ");
        for (let i = 0; i < words.length; i++) {
          for (let j = i + 1; j <= words.length; j++) if (words.slice(i, j).join("") === input) ids.add(a.id);
        }
      }
    }
    return ids.size ? bounded(ids, "exact") : { kind: "vague" };
  }

  const exact = idx.keys.get(input);
  if (exact) return exact.size === 1 ? { kind: "match", answerIds: [[...exact][0]], by: "exact" } : bounded(exact, "exact");

  const budget = typoBudget(input.length);
  if (budget === 0) return { kind: "none" };
  let best = budget + 1;
  let bestIds = new Set<string>();
  for (const [key, ids] of idx.keys) {
    const keyBudget = Math.min(budget, typoBudget(key.length));
    if (keyBudget === 0) continue;
    const d = editDistance(input, key, keyBudget);
    if (d > keyBudget) continue;
    if (d < best) {
      best = d;
      bestIds = new Set(ids);
    } else if (d === best) ids.forEach((id) => bestIds.add(id));
  }
  return bestIds.size ? bounded(bestIds, "fuzzy") : { kind: "none" };
}
