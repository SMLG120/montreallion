import { beforeEach, describe, expect, it } from "vitest";
import { seedBank } from "@/lib/game/bank";
import { ANSWER_MS, CONFIRM_GRACE_MS, createEngine, GameError, GRACE_MS, MAX_CHECKS } from "@/lib/game/engine";
import { checkAnswer, MAX_CANDIDATES } from "@/lib/game/match";
import { createMemoryStore } from "@/lib/game/store";
import type { QuestionDef } from "@/lib/game/types";

const sb = seedBank();
const orange = sb.get("stm-orange-line-station");
const habs = sb.get("habs-retired-number");
const boroughs = sb.get("city-borough");
const bridges = sb.get("south-shore-road-crossing");

describe("checkAnswer (double-check matcher)", () => {
  it("MATCH for exact labels, aliases, accent-free and French forms", () => {
    expect(checkAnswer(orange, "BERRI UQAM")).toEqual({ kind: "match", answerIds: ["berri-uqam"], by: "exact" });
    expect(checkAnswer(orange, "berri")).toMatchObject({ kind: "match", answerIds: ["berri-uqam"] });
    expect(checkAnswer(boroughs, "cote des neiges notre dame de grace")).toMatchObject({ kind: "match" });
    expect(checkAnswer(boroughs, "NDG")).toMatchObject({ kind: "match" });
    expect(checkAnswer(bridges, "Pont Jacques-Cartier")).toMatchObject({ kind: "match" });
    expect(checkAnswer(bridges, "jacques cartier bridge")).toMatchObject({ kind: "match" });
  });

  it("POSSIBLE (never auto-accepted) for typos, with the canonical entity", () => {
    const r = checkAnswer(orange, "Montmorecny");
    expect(r).toEqual({ kind: "possible", answerIds: ["montmorency"], by: "fuzzy" });
  });

  it("lists the few entities behind an ambiguous input for disambiguation", () => {
    const r = checkAnswer(habs, "Richard");
    expect(r.kind).toBe("possible");
    if (r.kind !== "possible") return;
    expect(r.answerIds.length).toBeGreaterThanOrEqual(2);
    expect(r.answerIds.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    for (const id of r.answerIds) expect(habs.answers.find((a) => a.id === id)!.en).toMatch(/Richard/);
  });

  it("is not an autocomplete: prefixes, short fragments and junk are NOT RECOGNIZED", () => {
    expect(checkAnswer(orange, "Ber")).toEqual({ kind: "none" });
    expect(checkAnswer(orange, "Mont")).toEqual({ kind: "none" });
    expect(checkAnswer(orange, "Côte")).toEqual({ kind: "none" });
    expect(checkAnswer(orange, "zzzzzzzz")).toEqual({ kind: "none" });
    expect(checkAnswer(orange, "   ")).toEqual({ kind: "none" });
  });

  it("caps candidates: too many equally close answers ⇒ vague, nothing listed", () => {
    const q: QuestionDef = {
      ...orange,
      id: "synthetic",
      ambiguous: undefined,
      answers: ["abcdeX1", "abcdeX2", "abcdeX3", "abcdeX4", "abcdeX5"].map((en, i) => ({ id: `a${i}`, en, aliases: [], est: 50 })),
    };
    expect(checkAnswer(q, "abcdeX")).toEqual({ kind: "vague" });
  });
});

let t = Date.parse("2026-11-21T15:00:00Z");
const now = () => t;
const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";
let engine: ReturnType<typeof createEngine>;

/** Starts an Unlimited session whose first question is the orange line (deterministic via a fixed pool). */
async function orangeSession() {
  const s = await engine.start(P, "unlimited", { category: "transit" });
  // Force a known first question so answers are predictable.
  const st = store;
  await st.mutate(s.id, (x) => {
    x.questionIds = ["stm-orange-line-station", ...x.questionIds.filter((id) => id !== "stm-orange-line-station")].slice(0, 7);
  });
  await engine.serve(s.id, P);
  return s.id;
}

let store: ReturnType<typeof createMemoryStore>;
beforeEach(() => {
  t = Date.parse("2026-11-21T15:00:00Z");
  store = createMemoryStore();
  engine = createEngine({ store, now, bank: async () => sb });
});

describe("engine.check / confirm", () => {
  it("does not consume the question and leaks no ids, scores or rarity", async () => {
    const id = await orangeSession();
    const { view, session } = await engine.check(id, P, 0, "berri");
    expect(view).toMatchObject({ status: "match", checksLeft: MAX_CHECKS - 1 });
    expect(view.candidates).toEqual([{ en: "Berri–UQAM", fr: "Berri–UQAM" }]);
    expect(session.index).toBe(0);
    expect(session.submissions).toHaveLength(0);
    const json = JSON.stringify(view);
    for (const leak of ["berri-uqam", "score", "share", "tier", "est", "aliases", "slug"]) expect(json).not.toContain(leak);
  });

  it("confirms the selected entity; the server scores it", async () => {
    const id = await orangeSession();
    const { view } = await engine.check(id, P, 0, "Montmorecny");
    expect(view.status).toBe("possible");
    expect(view.candidates[0].en).toBe("Montmorency");
    const { result } = await engine.submit(id, P, 0, "Montmorecny", 0);
    expect(result).toMatchObject({ status: "correct", answerId: "montmorency", matchedBy: "fuzzy" });
    expect((result as { score: number }).score).toBeGreaterThanOrEqual(10);
  });

  it("never silently swaps entities: declining a suggestion scores as typed", async () => {
    const id = await orangeSession();
    await engine.check(id, P, 0, "Montmorecny");
    const { result } = await engine.submit(id, P, 0, "Montmorecny");
    expect(result).toMatchObject({ status: "incorrect", score: 0 });
  });

  it("disambiguates in-session: picking one of several candidates", async () => {
    const s = await engine.start(P, "unlimited");
    await store.mutate(s.id, (x) => void (x.questionIds = ["habs-retired-number", ...x.questionIds.filter((q) => q !== "habs-retired-number")].slice(0, 7)));
    await engine.serve(s.id, P);
    const { view } = await engine.check(s.id, P, 0, "richard");
    expect(view.status).toBe("possible");
    const pick = view.candidates.findIndex((c) => c.en === "Henri Richard");
    expect(pick).toBeGreaterThanOrEqual(0);
    const { result } = await engine.submit(s.id, P, 0, "richard", pick);
    expect(result).toMatchObject({ status: "correct", answerId: habs.answers.find((a) => a.en === "Henri Richard")!.id });
  });

  it("rejects forged choices: no check, edited input, out of range", async () => {
    const id = await orangeSession();
    await expect(engine.submit(id, P, 0, "berri", 0)).rejects.toMatchObject({ code: "bad_choice" });
    await engine.check(id, P, 0, "berri");
    await expect(engine.submit(id, P, 0, "Namur", 0)).rejects.toMatchObject({ code: "bad_choice" });
    await expect(engine.submit(id, P, 0, "berri", 1)).rejects.toMatchObject({ code: "bad_choice" });
    // Nothing was consumed by the rejected attempts.
    const { result } = await engine.submit(id, P, 0, " BERRI ", 0); // same normalized key as the check
    expect(result).toMatchObject({ status: "correct", answerId: "berri-uqam" });
  });

  it("bounds enumeration: MAX_CHECKS distinct inputs per question; repeats are free", async () => {
    const id = await orangeSession();
    const inputs = ["zzzzzz", "yyyyyy", "xxxxxx", "wwwwww"];
    for (let i = 0; i < MAX_CHECKS; i++) {
      expect((await engine.check(id, P, 0, inputs[i])).view.status).toBe("none");
      expect((await engine.check(id, P, 0, inputs[i])).view.checksLeft).toBe(MAX_CHECKS - i - 1); // repeat: free
    }
    expect((await engine.check(id, P, 0, "Namur")).view).toMatchObject({ status: "limit", candidates: [] });
    // Still answerable directly afterwards.
    const { result } = await engine.submit(id, P, 0, "Namur");
    expect(result).toMatchObject({ status: "correct" });
  });

  it("checks are owner-only, in order, and not after the answer (duplicate submit)", async () => {
    const id = await orangeSession();
    await expect(engine.check(id, Q, 0, "berri")).rejects.toBeInstanceOf(GameError);
    await expect(engine.check(id, P, 1, "berri")).rejects.toMatchObject({ code: "out_of_order" });
    await engine.check(id, P, 0, "berri");
    await engine.submit(id, P, 0, "berri", 0);
    await expect(engine.submit(id, P, 0, "berri", 0)).rejects.toMatchObject({ code: "out_of_order" });
    await expect(engine.check(id, P, 0, "berri")).rejects.toMatchObject({ code: "out_of_order" });
  });

  it("a new question starts with a fresh check budget", async () => {
    const id = await orangeSession();
    for (const x of ["aaaaaa", "bbbbbb", "cccccc"]) await engine.check(id, P, 0, x);
    await engine.submit(id, P, 0, "cccccc");
    await engine.serve(id, P);
    expect((await engine.check(id, P, 1, "dddddd")).view.checksLeft).toBe(MAX_CHECKS - 1);
  });
});

describe("timer and confirmation grace", () => {
  it("a timely check may be confirmed within CONFIRM_GRACE_MS after the deadline", async () => {
    const id = await orangeSession();
    t += ANSWER_MS - 1_000;
    const { view } = await engine.check(id, P, 0, "Namur");
    expect(view.confirmBy).toBe(t + CONFIRM_GRACE_MS);
    t += CONFIRM_GRACE_MS - 100; // past the base deadline, inside the grace
    const { result } = await engine.submit(id, P, 0, "Namur", 0);
    expect(result).toMatchObject({ status: "correct" });
    expect((result as { elapsedMs: number }).elapsedMs).toBeLessThanOrEqual(ANSWER_MS + GRACE_MS);
  });

  it("grace is bounded and only covers the checked input", async () => {
    const id = await orangeSession();
    t += ANSWER_MS - 1_000;
    await engine.check(id, P, 0, "Namur");
    t += CONFIRM_GRACE_MS + 1;
    expect((await engine.submit(id, P, 0, "Namur", 0)).result).toMatchObject({ status: "expired", score: 0 });

    const id2 = await orangeSession();
    t += ANSWER_MS - 1_000;
    await engine.check(id2, P, 0, "Namur");
    t += 3_000; // inside the grace, but a different (unchecked) answer
    expect((await engine.submit(id2, P, 0, "Berri")).result).toMatchObject({ status: "expired" });
  });

  it("no check after the deadline, and an early check gives no extra time", async () => {
    const id = await orangeSession();
    await engine.check(id, P, 0, "Namur"); // at t=0
    t += ANSWER_MS + GRACE_MS + 1;
    expect((await engine.check(id, P, 0, "Berri")).view.status).toBe("expired");
    expect((await engine.submit(id, P, 0, "Namur", 0)).result).toMatchObject({ status: "expired" });
  });

  it("re-serving during the grace does not auto-expire the question", async () => {
    const id = await orangeSession();
    t += ANSWER_MS;
    await engine.check(id, P, 0, "Namur");
    t += GRACE_MS + 2_000; // past base deadline, inside the grace
    const { question } = await engine.serve(id, P);
    expect(question!.index).toBe(0);
    t += CONFIRM_GRACE_MS;
    const later = await engine.serve(id, P);
    expect(later.question!.index).toBe(1);
    expect(later.session.submissions[0].status).toBe("expired");
  });
});
