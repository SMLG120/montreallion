import { describe, expect, it } from "vitest";
import generated from "../../data/generated/questions.generated.json";
import { bankFileSchema } from "@/lib/game/schema";
import { checkAnswer } from "@/lib/game/match";
import { normalizeAnswer } from "@/lib/game/normalize";
import type { QuestionDef } from "@/lib/game/types";

/** Phase C (content expansion) templates: every question they produce is held to these rules. */
const PHASE_C = new Set([
  "heritage-in-area", "heritage-kind", "community-garden-in-area", "museum-list", "national-historic-site", "exo-line", "exo-island",
  "stm-bus-network", "park-kind", "neighbourhood-in-borough", "metro-opened", "wikipedia-list", "wiki-restaurant-open",
  "food-open-place", "wikipedia-event",
]);
const bank = bankFileSchema.parse(generated) as unknown as { questions: (QuestionDef & { generator: { template: string; contentHash: string } })[] };
const phaseC = bank.questions.filter((q) => PHASE_C.has(q.generator.template));
const LICENCES = /^(CC BY 4\.0|Creative Commons Attribution 4\.0|CC0|CC BY-SA 4\.0 \(facts only reused\)|ODbL 1\.0 \(© OpenStreetMap contributors\))/;

describe("phase C questions: provenance and integrity", () => {
  it("exist, are unique and do not overwrite earlier ids", () => {
    expect(phaseC.length).toBeGreaterThanOrEqual(200);
    const ids = bank.questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("are held for human review (never auto-approved)", () => {
    for (const q of phaseC) expect(["in_review", "approved"]).toContain(q.reviewStatus);
    // Approval only ever comes from etl/review/decisions.json; at import time none of them are approved.
    expect(phaseC.filter((q) => q.reviewStatus === "approved").length).toBe(0);
  });

  it.each(phaseC.map((q) => [q.id, q] as const))("%s: bilingual, scoped, sourced, ≥5 distinct answers", (_id, q) => {
    expect(q.prompt.en && q.prompt.fr && q.prompt.en !== q.prompt.fr).toBeTruthy();
    expect(q.eligibility.en && q.eligibility.fr).toBeTruthy();
    expect(["city", "island", "agglomeration", "greater", "province"]).toContain(q.scope);
    expect(q.sources.length).toBeGreaterThan(0);
    for (const s of q.sources) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.license).toMatch(LICENCES);
      expect(s.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(q.answers.length).toBeGreaterThanOrEqual(5);
    const keys = q.answers.map((a) => normalizeAnswer(a.en));
    expect(new Set(keys).size).toBe(keys.length);
    // Every answer is recognised as itself by the double-check (no alias stolen by a neighbour).
    for (const a of q.answers) {
      const r = checkAnswer(q, a.en);
      expect(r.kind === "match" || r.kind === "possible", `${a.en} → ${r.kind}`).toBe(true);
      if (r.kind === "match") expect(r.answerIds).toEqual([a.id]);
      expect(a.est).toBeGreaterThanOrEqual(1);
      expect(a.est).toBeLessThanOrEqual(100);
    }
  });

  it("most answers carry a canonical id (Wikidata QID, RPCQ, GTFS, registry…)", () => {
    const answers = phaseC.flatMap((q) => q.answers);
    const withRef = answers.filter((a) => (a.refs ?? []).length > 0).length;
    expect(withRef / answers.length).toBeGreaterThan(0.5);
  });

  it("every OSM food answer is backed by an OPEN City registry establishment", () => {
    const food = phaseC.filter((q) => q.generator.template === "food-open-place");
    expect(food.length).toBeGreaterThanOrEqual(90);
    for (const q of food) {
      expect(q.sources.some((s) => s.license.startsWith("ODbL"))).toBe(true);
      for (const a of q.answers) expect(a.refs?.some((x) => x.startsWith("mtl-food:")), `${q.id}: ${a.en}`).toBe(true);
    }
  });

  it("restaurants are only included when open in the City's food registry", () => {
    const r = phaseC.find((q) => q.generator.template === "wiki-restaurant-open")!;
    for (const a of r.answers) expect(a.refs?.some((x) => x.startsWith("mtl-food:"))).toBe(true);
    expect(r.answers.map((a) => a.en)).not.toContain("Montreal Pool Room");
  });
});
