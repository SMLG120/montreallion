import { describe, expect, it } from "vitest";
import { seedBank } from "@/lib/game/bank";

const bank = seedBank();
const QUESTIONS = bank.questions;
const getQuestion = (id: string) => bank.get(id);
import { dailyQuestions, dateKey } from "@/lib/game/daily";
import { rarityScore, tierFor } from "@/lib/game/scoring";

describe("rarity scoring", () => {
  it("keeps every correct answer between 10 and 100", () => {
    for (const q of QUESTIONS) for (const a of q.answers) {
      const { score } = rarityScore(q, a.id);
      expect(score).toBeGreaterThanOrEqual(10);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
  it("gives the most familiar answer 10 and rarer answers more", () => {
    const q = getQuestion("stm-orange-line-station");
    expect(rarityScore(q, "berri-uqam").score).toBe(10);
    expect(rarityScore(q, "de-la-savane").score).toBeGreaterThan(rarityScore(q, "jean-talon").score);
  });
  it("maps scores to tiers", () => {
    expect(tierFor(95)).toBe("legend");
    expect(tierFor(80)).toBe("gem");
    expect(tierFor(60)).toBe("expert");
    expect(tierFor(40)).toBe("regular");
    expect(tierFor(10)).toBe("tourist");
  });
});

describe("daily challenge", () => {
  it("rolls over at midnight America/Toronto, not UTC", () => {
    expect(dateKey(new Date("2026-11-22T04:59:00Z"))).toBe("2026-11-21"); // 23:59 EST
    expect(dateKey(new Date("2026-11-22T05:00:00Z"))).toBe("2026-11-22"); // 00:00 EST
    expect(dateKey(new Date("2026-07-02T03:59:00Z"))).toBe("2026-07-01"); // 23:59 EDT
  });
  it("is deterministic per day, 7 distinct questions with distinct categories", () => {
    const a = dailyQuestions(QUESTIONS, "2026-11-21");
    expect(dailyQuestions(QUESTIONS, "2026-11-21").map((q) => q.id)).toEqual(a.map((q) => q.id));
    expect(a).toHaveLength(7);
    expect(new Set(a.map((q) => q.id)).size).toBe(7);
    expect(new Set(a.map((q) => q.category)).size).toBe(7);
    expect(dailyQuestions(QUESTIONS, "2026-11-22").map((q) => q.id)).not.toEqual(a.map((q) => q.id));
  });
});
