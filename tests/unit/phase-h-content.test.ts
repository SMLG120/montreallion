import { describe, expect, it } from "vitest";
import generated from "../../data/generated/questions.generated.json";
import seed from "../../data/seed/questions.json";
import decisions from "../../etl/review/decisions.json";
import { bankFileSchema } from "@/lib/game/schema";
import { checkAnswer } from "@/lib/game/match";
import { normalizeAnswer } from "@/lib/game/normalize";
import { CATEGORY_IDS, type QuestionDef } from "@/lib/game/types";

/** Phase H (bank rebalancing): difficulty on every question, provenance, uniqueness, review gating. */
type Q = QuestionDef & { generator?: { template: string; concept: string; contentHash: string } };
const gen = bankFileSchema.parse(generated).questions as Q[];
const all = [...(bankFileSchema.parse(seed).questions as Q[]), ...gen];
const PHASE_H = new Set(["wikidata-relation", "area-adjacency", "metro-line-areas", "street-in-borough", "district-in-borough"]);
const phaseH = gen.filter((q) => PHASE_H.has(q.generator!.template));
const LICENCES = /^(CC BY 4\.0|Creative Commons Attribution 4\.0|CC0|CC BY-SA 4\.0 \(facts only reused\)|ODbL 1\.0 \(© OpenStreetMap contributors\))/;

describe("question bank: difficulty, uniqueness, provenance (Phase H)", () => {
  it("every question has an editorial difficulty", () => {
    for (const q of all) expect(["easy", "medium", "hard"], q.id).toContain(q.difficulty);
  });

  it("ids and prompts are unique across seed and generated files", () => {
    const ids = all.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    const prompts = all.map((q) => normalizeAnswer(q.prompt.en));
    expect(new Set(prompts).size).toBe(prompts.length);
  });

  it("every question is in a known category with cited, licensed, dated sources", () => {
    for (const q of all) {
      expect(CATEGORY_IDS as readonly string[]).toContain(q.category);
      expect(q.sources.length, q.id).toBeGreaterThan(0);
      for (const s of q.sources) {
        expect(() => new URL(s.url), q.id).not.toThrow();
        expect(s.retrieved, q.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        if (q.generator) expect(s.license, q.id).toMatch(LICENCES);
      }
    }
  });

  it("phase H questions exist and are never auto-approved", () => {
    expect(phaseH.length).toBeGreaterThanOrEqual(60);
    for (const q of phaseH) {
      if (q.reviewStatus !== "approved") {
        expect(q.reviewStatus, q.id).toBe("in_review");
        continue;
      }
      const d = (decisions as Record<string, { status: string; contentHash: string }>)[q.id];
      expect(d?.status, q.id).toBe("approved");
      expect(d?.contentHash, q.id).toBe(q.generator!.contentHash);
    }
  });

  it.each(phaseH.map((q) => [q.id, q] as const))("%s: bilingual, ≥3 distinct answers, each answer accepted as itself", (_id, q) => {
    expect(q.prompt.en !== q.prompt.fr && q.eligibility.en && q.eligibility.fr).toBeTruthy();
    const keys = new Set(q.answers.map((a) => normalizeAnswer(a.en)));
    expect(keys.size).toBe(q.answers.length);
    expect(keys.size).toBeGreaterThanOrEqual(3);
    // Every answer label resolves to that answer (no alias of another answer captures it).
    for (const a of q.answers.slice(0, 40)) {
      const r = checkAnswer(q, a.en);
      expect(r.kind === "match" || r.kind === "possible", `${q.id}: ${a.en} → ${r.kind}`).toBe(true);
      if (r.kind === "match") expect(r.answerIds, `${q.id}: ${a.en}`).toEqual([a.id]);
    }
  });

  it("Wikidata relationship answers keep their canonical entity id", () => {
    for (const q of phaseH.filter((q) => q.generator!.template === "wikidata-relation")) {
      for (const a of q.answers) expect(a.refs?.some((r) => /^wikidata:Q\d+$/.test(r)), `${q.id}: ${a.en}`).toBe(true);
    }
  });
});
