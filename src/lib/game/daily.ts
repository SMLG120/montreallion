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

function shuffle<T>(items: T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Picks `count` questions, preferring one per category before repeating any category. */
export function pickQuestions<Q extends { id: string; category: CategoryId }>(pool: Q[], rand: () => number, count = QUESTIONS_PER_GAME): Q[] {
  const shuffled = shuffle([...pool].sort((a, b) => a.id.localeCompare(b.id)), rand);
  const picked: Q[] = [];
  const used = new Set<CategoryId>();
  for (const q of shuffled) {
    if (picked.length >= count) break;
    if (!used.has(q.category)) {
      picked.push(q);
      used.add(q.category);
    }
  }
  for (const q of shuffled) {
    if (picked.length >= count) break;
    if (!picked.includes(q)) picked.push(q);
  }
  return picked;
}

export function dailyQuestions<Q extends { id: string; category: CategoryId }>(pool: Q[], key: string): Q[] {
  return pickQuestions(pool, seededRandom(`montreallion-daily:${key}`));
}
