import { describe, expect, it } from "vitest";
import { seedBank } from "@/lib/game/bank";
import { checkAnswer, matchAnswer, MAX_CANDIDATES, surnameKeys } from "@/lib/game/match";
import { normalizeAnswer } from "@/lib/game/normalize";
import type { QuestionDef } from "@/lib/game/types";

/** Phase I: surname-only matching for people, ambiguity handling, abbreviations, bounded candidates. */
const people = (names: string[], answerType: QuestionDef["answerType"] = "person"): QuestionDef => ({
  id: "synthetic-people",
  category: "sports",
  scope: "city",
  prompt: { en: "Name a person.", fr: "Nommez une personne." },
  eligibility: { en: "People.", fr: "Personnes." },
  verification: "source-checked",
  reviewStatus: "approved",
  sources: [],
  answers: names.map((en, i) => ({ id: `p${i}`, en, aliases: [], est: 50 })),
  answerType,
});

const q = people(["Maurice Richard", "Henri Richard", "Guy Lafleur", "Greg Van Avermaet", "Charlotte Robillard-Millette", "Émile Bélanger", "Bobby Orr Jr."]);
const id = (name: string) => q.answers.find((a) => a.en === name)!.id;

describe("surnameKeys", () => {
  it("derives surname, particle-free surname and initial + surname", () => {
    expect(surnameKeys("Guy Lafleur")).toEqual(["lafleur", "glafleur"]);
    expect(surnameKeys("Greg Van Avermaet")).toEqual(["vanavermaet", "avermaet", "gvanavermaet"]);
    expect(surnameKeys("Charlotte Robillard-Millette")).toEqual(["robillardmillette", "crobillardmillette"]);
    expect(surnameKeys("Bobby Orr Jr.")).toEqual(["orr", "borr"]);
  });

  it("gives no surname for single names, duos and disambiguated labels", () => {
    expect(surnameKeys("Ariel")).toEqual([]);
    expect(surnameKeys("Adirley Queirós & Joana Pimenta")).toEqual([]);
    expect(surnameKeys("Simon and Garfunkel")).toEqual([]);
    expect(surnameKeys("John Smith (footballer)")).toEqual([]);
  });
});

describe("surname-only answers (people questions)", () => {
  it("accepts a surname that identifies exactly one eligible person", () => {
    expect(matchAnswer(q, "Lafleur")).toEqual({ kind: "match", answerId: id("Guy Lafleur"), by: "exact" });
    expect(checkAnswer(q, "lafleur")).toEqual({ kind: "match", answerIds: [id("Guy Lafleur")], by: "exact" });
    expect(matchAnswer(q, "G. Lafleur")).toMatchObject({ kind: "match", answerId: id("Guy Lafleur") });
    expect(matchAnswer(q, "Avermaet")).toMatchObject({ kind: "match", answerId: id("Greg Van Avermaet") });
    expect(matchAnswer(q, "van avermaet")).toMatchObject({ kind: "match", answerId: id("Greg Van Avermaet") });
    expect(matchAnswer(q, "Robillard-Millette")).toMatchObject({ kind: "match", answerId: id("Charlotte Robillard-Millette") });
    expect(matchAnswer(q, "Orr")).toMatchObject({ kind: "match", answerId: id("Bobby Orr Jr.") });
  });

  it("matches accented French names with or without accents", () => {
    expect(matchAnswer(q, "Belanger")).toMatchObject({ kind: "match", answerId: id("Émile Bélanger") });
    expect(matchAnswer(q, "BÉLANGER")).toMatchObject({ kind: "match", answerId: id("Émile Bélanger") });
    expect(matchAnswer(q, "emile belanger")).toMatchObject({ kind: "match", answerId: id("Émile Bélanger") });
  });

  it("never accepts a shared surname: the player must pick the person", () => {
    expect(matchAnswer(q, "Richard")).toEqual({ kind: "ambiguous" });
    const r = checkAnswer(q, "Richard");
    expect(r.kind).toBe("possible");
    if (r.kind === "possible") expect(new Set(r.answerIds)).toEqual(new Set([id("Maurice Richard"), id("Henri Richard")]));
    // An initial that singles one out is enough.
    expect(matchAnswer(q, "M. Richard")).toMatchObject({ kind: "match", answerId: id("Maurice Richard") });
  });

  it("a surname shared by more people than can be listed is too vague (nothing revealed)", () => {
    const many = people(["Ann Roy", "Bob Roy", "Carl Roy", "Dan Roy", "Eve Roy"]);
    expect(MAX_CANDIDATES).toBe(3);
    expect(checkAnswer(many, "Roy")).toEqual({ kind: "vague" });
    expect(matchAnswer(many, "Roy")).toEqual({ kind: "ambiguous" });
  });

  it("surnames are exact-only: no typo matching, substrings or prefixes", () => {
    expect(matchAnswer(q, "Lafleurr")).toEqual({ kind: "none" });
    expect(checkAnswer(q, "Laflur")).toEqual({ kind: "none" });
    expect(matchAnswer(q, "Laf")).toEqual({ kind: "none" });
    expect(matchAnswer(q, "fleur")).toEqual({ kind: "none" });
    // Typo matching on the full name still works, and still needs confirmation in the double-check.
    expect(checkAnswer(q, "Guy Lafluer")).toEqual({ kind: "possible", answerIds: [id("Guy Lafleur")], by: "fuzzy" });
  });

  it("a full name or listed alias of another answer always wins over a surname", () => {
    const mixed: QuestionDef = { ...people(["Guy Lafleur", "Pierre Lapointe"]), answers: [...people(["Guy Lafleur", "Pierre Lapointe"]).answers, { id: "band", en: "Lafleur", aliases: [], est: 50 }] };
    expect(matchAnswer(mixed, "Lafleur")).toEqual({ kind: "match", answerId: "band", by: "exact" });
    expect(matchAnswer(mixed, "Lapointe")).toMatchObject({ kind: "match", answerId: mixed.answers[1].id });
  });

  it("only applies to questions whose answers are people", () => {
    const places: QuestionDef = { ...people(["Guy Lafleur", "Maurice Richard"]), answerType: undefined };
    expect(matchAnswer(places, "Lafleur")).toEqual({ kind: "none" });
    expect(checkAnswer(places, "Lafleur")).toEqual({ kind: "none" });
  });

  it("works on the real seed questions marked as people", () => {
    const sb = seedBank();
    const habs = sb.get("habs-retired-number");
    const mayors = sb.get("mayor-1960-2020");
    expect(habs.answerType).toBe("person");
    expect(matchAnswer(habs, "Lafleur")).toMatchObject({ kind: "match", answerId: habs.answers.find((a) => a.en === "Guy Lafleur")!.id });
    expect(matchAnswer(habs, "Richard").kind).toBe("ambiguous");
    expect(matchAnswer(mayors, "Drapeau")).toMatchObject({ kind: "match", answerId: mayors.answers.find((a) => a.en === "Jean Drapeau")!.id });
  });
});

describe("abbreviations", () => {
  it("expands common street and place abbreviations", () => {
    expect(normalizeAnswer("boul. St-Laurent")).toBe(normalizeAnswer("Boulevard Saint-Laurent"));
    expect(normalizeAnswer("Av. du Parc")).toBe(normalizeAnswer("Avenue du Parc"));
    expect(normalizeAnswer("Mt Royal")).toBe(normalizeAnswer("Mount Royal"));
    expect(normalizeAnswer("Heavy MTL")).toBe(normalizeAnswer("Heavy Montréal"));
  });
});
