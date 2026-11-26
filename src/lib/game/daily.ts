import { normalizeAnswer } from "./normalize";
import type { CategoryId } from "./types";

export const GAME_TZ = "America/Toronto";
export const QUESTIONS_PER_GAME = 7;

/** YYYY-MM-DD for the given instant in Montréal time (midnight reset in America/Toronto). */
export function dateKey(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: GAME_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function seededRandom(seed: string): () => number {
  let a = fnv1a(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Difficulty = "easy" | "medium" | "hard";

/** Target difficulty mix of a game (Phase K); the picker meets it when the pool allows, then relaxes it. */
export const DIFFICULTY_MIX: Record<Difficulty, number> = { easy: 0.4, medium: 0.4, hard: 0.2 };

/**
 * Relative chance of a category's questions coming up first (1 = neutral). The picker still takes one
 * question per category before repeating any, so weights decide which categories fill a game, not how often
 * one category repeats.
 */
export const CATEGORY_WEIGHTS: Partial<Record<CategoryId, number>> = {};

/** Two questions whose answer sets overlap this much (shared / smaller set) are too alike for one game. */
export const NEAR_DUPLICATE = 0.6;

type Pickable = { id: string; category: CategoryId; difficulty?: Difficulty; answers?: { en: string }[] };

/** Per-game difficulty caps from DIFFICULTY_MIX by largest remainder (7 questions → 3 easy, 3 medium, 1 hard). */
export function difficultyQuota(count: number): Record<Difficulty, number> {
  const levels = Object.keys(DIFFICULTY_MIX) as Difficulty[];
  const raw = levels.map((d) => DIFFICULTY_MIX[d] * count);
  const q = raw.map(Math.floor);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; q.reduce((a, b) => a + b, 0) < count; k++) q[order[k % order.length][1]]++;
  return Object.fromEntries(levels.map((d, i) => [d, q[i]])) as Record<Difficulty, number>;
}

function answerKeys(q: Pickable): Set<string> {
  return new Set((q.answers ?? []).map((a) => normalizeAnswer(a.en)).filter(Boolean));
}

function tooAlike(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const k of a) if (b.has(k)) shared++;
  return shared / Math.min(a.size, b.size) >= NEAR_DUPLICATE;
}

/**
 * Picks `count` questions: one per category before any category repeats, the DIFFICULTY_MIX quota, and never two
 * near-identical questions (overlapping answer sets) in one game. Each rule is relaxed in turn (difficulty, then
 * category, then similarity) only when the pool can't satisfy it, so small or single-category pools still fill.
 * Deterministic for a given `rand`.
 */
export function pickQuestions<Q extends Pickable>(pool: Q[], rand: () => number, count = QUESTIONS_PER_GAME): Q[] {
  // Weighted random order (Efraimidis–Spirakis): key = u^(1/w); with all weights 1 this is a uniform shuffle.
  const ordered = [...pool]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((q) => ({ q, k: rand() ** (1 / Math.max(CATEGORY_WEIGHTS[q.category] ?? 1, 1e-6)) }))
    .sort((a, b) => b.k - a.k)
    .map((x) => x.q);
  const quota = difficultyQuota(count);
  const keys = new Map(ordered.map((q) => [q.id, answerKeys(q)]));
  const picked: Q[] = [];
  const cats = new Set<CategoryId>();
  const levels: Record<Difficulty, number> = { easy: 0, medium: 0, hard: 0 };
  const passes: { category: boolean; difficulty: boolean; similar: boolean }[] = [
    { category: true, difficulty: true, similar: true },
    { category: true, difficulty: false, similar: true },
    { category: false, difficulty: false, similar: true },
    { category: false, difficulty: false, similar: false },
  ];
  for (const rule of passes) {
    for (const q of ordered) {
      if (picked.length >= count) return picked;
      if (picked.includes(q)) continue;
      if (rule.category && cats.has(q.category)) continue;
      if (rule.difficulty && q.difficulty && levels[q.difficulty] >= quota[q.difficulty]) continue;
      if (rule.similar && picked.some((p) => tooAlike(keys.get(p.id)!, keys.get(q.id)!))) continue;
      picked.push(q);
      cats.add(q.category);
      if (q.difficulty) levels[q.difficulty]++;
    }
  }
  return picked;
}

export function dailyQuestions<Q extends Pickable>(pool: Q[], key: string): Q[] {
  return pickQuestions(pool, seededRandom(`montreallion-daily:${key}`));
}
