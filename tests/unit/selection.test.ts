import { afterEach, describe, expect, it } from "vitest";
import { seedBank } from "@/lib/game/bank";
import { CATEGORY_WEIGHTS, dailyQuestions, difficultyQuota, type Difficulty, NEAR_DUPLICATE, pickQuestions, seededRandom } from "@/lib/game/daily";
import { createEngine, GameError } from "@/lib/game/engine";
import { normalizeAnswer } from "@/lib/game/normalize";
import { createMemoryStore } from "@/lib/game/store";
import type { CategoryId } from "@/lib/game/types";

/** Phase K: question selection (category balance, difficulty mix, no near-duplicates, weights, filters). */
type Q = { id: string; category: CategoryId; difficulty?: Difficulty; answers: { en: string }[] };
const CATS: CategoryId[] = ["transit", "boroughs", "parks", "food", "history", "festivals", "sports", "universities", "winter"];
const LEVELS: Difficulty[] = ["easy", "medium", "hard"];
const synthetic = (n: number): Q[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `q${String(i).padStart(3, "0")}`,
    category: CATS[i % CATS.length],
    difficulty: LEVELS[Math.floor(i / CATS.length) % 3],
    answers: [0, 1, 2, 3, 4].map((k) => ({ en: `answer ${i} ${k}` })),
  }));
const count = (qs: { difficulty?: Difficulty }[], d: Difficulty) => qs.filter((q) => q.difficulty === d).length;
const overlap = (a: Q, b: Q) => {
  const ka = new Set(a.answers.map((x) => normalizeAnswer(x.en)));
  const kb = new Set(b.answers.map((x) => normalizeAnswer(x.en)));
  return [...ka].filter((k) => kb.has(k)).length / Math.min(ka.size, kb.size);
};

afterEach(() => {
  for (const k of Object.keys(CATEGORY_WEIGHTS)) delete CATEGORY_WEIGHTS[k as CategoryId];
});

describe("difficulty quota", () => {
  it("splits a game 40/40/20 by largest remainder", () => {
    expect(difficultyQuota(7)).toEqual({ easy: 3, medium: 3, hard: 1 });
    expect(difficultyQuota(5)).toEqual({ easy: 2, medium: 2, hard: 1 });
    expect(difficultyQuota(10)).toEqual({ easy: 4, medium: 4, hard: 2 });
    for (const n of [1, 3, 7, 12]) expect(Object.values(difficultyQuota(n)).reduce((a, b) => a + b)).toBe(n);
  });
});

describe("pickQuestions", () => {
  it("one question per category and the difficulty mix when the pool allows it", () => {
    const pool = synthetic(90);
    for (let seed = 0; seed < 50; seed++) {
      const picked = pickQuestions(pool, seededRandom(`s${seed}`));
      expect(picked).toHaveLength(7);
      expect(new Set(picked.map((q) => q.category)).size).toBe(7);
      expect([count(picked, "easy"), count(picked, "medium"), count(picked, "hard")]).toEqual([3, 3, 1]);
    }
  });

  it("is deterministic for a seed", () => {
    const pool = synthetic(90);
    expect(pickQuestions(pool, seededRandom("x")).map((q) => q.id)).toEqual(pickQuestions(pool, seededRandom("x")).map((q) => q.id));
  });

  it("never puts two near-identical questions in one game when there are alternatives", () => {
    const pool = synthetic(90);
    // A copy of q000 under another category, with the same answers.
    pool.push({ ...pool[0], id: "zz-copy", category: "food" });
    for (let seed = 0; seed < 100; seed++) {
      const ids = pickQuestions(pool, seededRandom(`d${seed}`)).map((q) => q.id);
      expect(ids.includes("q000") && ids.includes("zz-copy"), `seed ${seed}`).toBe(false);
    }
  });

  it("falls back gracefully: small or single-category pools still fill the game", () => {
    const tiny = synthetic(9).filter((q) => q.category === "transit").concat(synthetic(30).filter((q) => q.category === "transit"));
    const unique = [...new Map(tiny.map((q) => [q.id, q])).values()];
    const picked = pickQuestions(unique, seededRandom("t"), 3);
    expect(picked).toHaveLength(3);
    expect(new Set(picked.map((q) => q.id)).size).toBe(3);
    // Only near-duplicates left: still filled rather than coming up short.
    const dupes = [0, 1, 2].map((i) => ({ id: `d${i}`, category: "parks" as CategoryId, answers: [{ en: "same a" }, { en: "same b" }, { en: "same c" }] }));
    expect(pickQuestions(dupes, seededRandom("u"), 3)).toHaveLength(3);
    expect(pickQuestions([], seededRandom("v"))).toEqual([]);
  });

  it("category weights change which categories fill a game", () => {
    const pool = synthetic(90);
    const firstFood = (runs: number) => {
      let n = 0;
      for (let s = 0; s < runs; s++) if (pickQuestions(pool, seededRandom(`w${s}`), 1)[0].category === "food") n++;
      return n;
    };
    const neutral = firstFood(300);
    CATEGORY_WEIGHTS.food = 20;
    expect(firstFood(300)).toBeGreaterThan(neutral * 3);
  });
});

describe("daily selection on the real reviewed bank", () => {
  const bank = seedBank();
  it("varied categories, the difficulty mix where possible, no near-duplicates, for 120 days", () => {
    const quota = difficultyQuota(7);
    let onMix = 0;
    const days = 120;
    for (let d = 1; d <= days; d++) {
      const key = `2027-01-${String(((d - 1) % 28) + 1).padStart(2, "0")}-${d}`;
      const picked = dailyQuestions(bank.questions, key);
      expect(picked).toHaveLength(7);
      expect(new Set(picked.map((q) => q.category)).size, key).toBeGreaterThanOrEqual(6);
      // The mix is a target: the picker relaxes it on the rare day the categories can't fit it.
      if (LEVELS.every((lv) => count(picked, lv) === quota[lv])) onMix++;
      expect(new Set(picked.map((q) => q.difficulty)).size, key).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < picked.length; i++)
        for (let j = i + 1; j < picked.length; j++) expect(overlap(picked[i] as Q, picked[j] as Q), `${picked[i].id} ~ ${picked[j].id}`).toBeLessThan(NEAR_DUPLICATE);
    }
    expect(onMix / days).toBeGreaterThanOrEqual(0.95);
  });
});

describe("Unlimited difficulty filter", () => {
  const P = "11111111-1111-4111-8111-111111111111";
  it("uses the stored difficulty", async () => {
    const engine = createEngine({ store: createMemoryStore(), bank: async () => seedBank() });
    for (const lv of LEVELS) {
      const s = await engine.start(P, "unlimited", { difficulty: lv });
      expect(s.questionIds).toHaveLength(7);
      for (const id of s.questionIds) expect(seedBank().get(id).difficulty).toBe(lv);
    }
  });

  it("combines with a category, and refuses a pool that is too small", async () => {
    const engine = createEngine({ store: createMemoryStore(), bank: async () => seedBank() });
    const s = await engine.start(P, "unlimited", { category: "food", difficulty: "medium" });
    for (const id of s.questionIds) expect(seedBank().get(id)).toMatchObject({ category: "food", difficulty: "medium" });
    await expect(engine.start(P, "unlimited", { category: "winter", difficulty: "hard" })).rejects.toBeInstanceOf(GameError);
  });
});
