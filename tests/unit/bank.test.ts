import { describe, expect, it } from "vitest";
import { seedBank } from "@/lib/game/bank";

const bank = seedBank();
const QUESTIONS = bank.questions;
import { answerKeys } from "@/lib/game/match";
import { normalizeAnswer } from "@/lib/game/normalize";

describe("seed question bank integrity", () => {
  it("has enough approved questions across categories for a 7-question game", () => {
    expect(QUESTIONS.length).toBeGreaterThanOrEqual(7);
    expect(new Set(QUESTIONS.map((q) => q.category)).size).toBeGreaterThanOrEqual(7);
  });
  it("has unique question ids", () => {
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(QUESTIONS.length);
  });
  for (const q of QUESTIONS) {
    it(`${q.id}: answers are unique and no normalized alias maps to two answers`, () => {
      expect(new Set(q.answers.map((a) => a.id)).size).toBe(q.answers.length);
      const owner = new Map<string, string>();
      for (const a of q.answers) {
        for (const k of answerKeys(a)) {
          const prev = owner.get(k);
          expect(prev === undefined || prev === a.id, `key "${k}" shared by ${prev} and ${a.id}`).toBe(true);
          owner.set(k, a.id);
        }
      }
      for (const amb of q.ambiguous ?? []) expect(owner.has(normalizeAnswer(amb))).toBe(false);
      expect(q.prompt.fr).not.toBe(q.prompt.en);
    });
  }
});
