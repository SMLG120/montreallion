import { describe, expect, it } from "vitest";
import { seedBank } from "@/lib/game/bank";

const bank = seedBank();
const getQuestion = (id: string) => bank.get(id);
import { matchAnswer } from "@/lib/game/match";
import { editDistance, normalizeAnswer } from "@/lib/game/normalize";

const orange = getQuestion("stm-orange-line-station");
const habs = getQuestion("habs-retired-number");
const boroughs = getQuestion("city-borough");

describe("normalizeAnswer", () => {
  it("ignores accents, case, dashes and apostrophes", () => {
    expect(normalizeAnswer("Berri–UQAM")).toBe(normalizeAnswer("berri uqam"));
    expect(normalizeAnswer("Côte-Sainte-Catherine")).toBe(normalizeAnswer("cote ste catherine"));
    expect(normalizeAnswer("Lucien-L'Allier")).toBe(normalizeAnswer("lucien lallier"));
    expect(normalizeAnswer("Station Crémazie")).toBe("cremazie");
    expect(normalizeAnswer("Mount Royal")).toBe(normalizeAnswer("Mont-Royal"));
  });
  it("computes transposition distance", () => {
    expect(editDistance("jarry", "jarry")).toBe(0);
    expect(editDistance("montmorecny", "montmorency")).toBe(1);
  });
});

describe("matchAnswer", () => {
  it("matches canonical names, aliases and accent-free input", () => {
    expect(matchAnswer(orange, "BERRI-UQAM")).toEqual({ kind: "match", answerId: "berri-uqam", by: "exact" });
    expect(matchAnswer(orange, "berri")).toMatchObject({ answerId: "berri-uqam" });
    expect(matchAnswer(orange, "vendome")).toMatchObject({ answerId: "vendome", by: "exact" });
    expect(matchAnswer(boroughs, "the plateau")).toMatchObject({ answerId: "plateau" });
    expect(matchAnswer(boroughs, "NDG")).toMatchObject({ answerId: "cdn-ndg" });
  });
  it("accepts small typos on long names only", () => {
    expect(matchAnswer(orange, "Montmorecny")).toMatchObject({ answerId: "montmorency", by: "fuzzy" });
    expect(matchAnswer(orange, "Henri Bourrassa")).toMatchObject({ answerId: "henri-bourassa", by: "fuzzy" });
    expect(matchAnswer(orange, "Jary")).toEqual({ kind: "none" }); // short keys must be exact
  });
  it("rejects wrong answers from other lines", () => {
    expect(matchAnswer(orange, "Atwater")).toEqual({ kind: "none" });
    expect(matchAnswer(orange, "McGill")).toEqual({ kind: "none" });
    expect(matchAnswer(boroughs, "Westmount")).toEqual({ kind: "none" });
  });
  it("flags ambiguous input instead of guessing", () => {
    expect(matchAnswer(habs, "Richard")).toEqual({ kind: "ambiguous" });
    expect(matchAnswer(habs, "Rocket Richard")).toMatchObject({ answerId: "maurice-richard" });
    expect(matchAnswer(habs, "Henri Richard")).toMatchObject({ answerId: "henri-richard" });
  });
  it("handles empty / garbage input", () => {
    expect(matchAnswer(orange, "   ")).toEqual({ kind: "none" });
    expect(matchAnswer(orange, "!!!")).toEqual({ kind: "none" });
  });
});
