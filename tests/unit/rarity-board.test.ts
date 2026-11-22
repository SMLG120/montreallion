import { describe, expect, it } from "vitest";
import { buildBank, seedBank } from "@/lib/game/bank";
import { createEngine, summarize } from "@/lib/game/engine";
import { checkDisplayName } from "@/lib/game/names";
import { MIN_SAMPLE, rarityScore, rarityTable, type AnswerCounts } from "@/lib/game/scoring";
import { anonTag, createMemoryStore, rankBoard } from "@/lib/game/store";

const Q = () => seedBank().get("stm-orange-line-station");

function counts(bySlug: Record<string, number>): AnswerCounts {
  return { n: Object.values(bySlug).reduce((a, b) => a + b, 0), bySlug };
}

describe("observed-v1 rarity", () => {
  it("is exactly estimated-v1 below the minimum sample", () => {
    const q = Q();
    const table = rarityTable(q, counts({ "berri-uqam": MIN_SAMPLE - 1 }));
    for (const a of q.answers) {
      expect(table[a.id].score).toBe(rarityScore(q, a.id).score);
      expect(table[a.id].basis).toBe("estimated");
    }
  });

  it("switches to observed frequencies at the minimum sample", () => {
    const q = Q();
    // Everyone says a normally-rare station: it becomes the common (10-point) answer.
    const table = rarityTable(q, counts({ "de-la-savane": 200, "berri-uqam": 5 }));
    expect(table["de-la-savane"].basis).toBe("observed");
    expect(table["de-la-savane"].n).toBe(205);
    expect(table["de-la-savane"].score).toBe(10);
    expect(table["berri-uqam"].score).toBeGreaterThan(table["de-la-savane"].score);
    for (const r of Object.values(table)) expect(r.score).toBeGreaterThanOrEqual(10);
    const shareSum = Object.values(table).reduce((s, r) => s + r.share, 0);
    expect(shareSum).toBeCloseTo(1, 6);
  });

  it("is smoothed: one extra player barely moves a score, more players lower it", () => {
    const q = Q();
    const base = { "berri-uqam": 20, "jean-talon": 10, "de-la-savane": 1 };
    const a = rarityTable(q, counts(base))["jean-talon"].score;
    const b = rarityTable(q, counts({ ...base, "jean-talon": 11 }))["jean-talon"].score;
    const c = rarityTable(q, counts({ ...base, "jean-talon": 18 }))["jean-talon"].score;
    expect(Math.abs(a - b)).toBeLessThanOrEqual(4);
    expect(c).toBeLessThan(a);
  });
});

describe("engine with play statistics", () => {
  const seed = seedBank();
  const stats = new Map([["stm-orange-line-station", counts({ "de-la-savane": 100 })]]);
  const bank = buildBank("t", "observed-v1", seed.questions, undefined, stats);
  const P = "11111111-1111-4111-8111-111111111111";

  it("scores unlimited answers live with basis + sample, and freezes basis into the daily snapshot", async () => {
    let t = Date.parse("2026-11-21T15:00:00Z");
    const engine = createEngine({ store: createMemoryStore(), now: () => t, random: () => 0, bank: async () => bank });
    const s = await engine.start(P, "daily");
    const snap = s.frozenScores!;
    for (const qid of s.questionIds) {
      const entries = Object.values(snap[qid]);
      expect(entries.every((e) => e.basis === (qid === "stm-orange-line-station" ? "observed" : "estimated"))).toBe(true);
    }
    const { question } = await engine.serve(s.id, P);
    t += 2000;
    const { result } = await engine.submit(s.id, P, 0, bank.get(question!.id).answers[0].en);
    if (result.status === "retry") throw new Error("retry");
    expect(result.basis).toBe(question!.id === "stm-orange-line-station" ? "observed" : "estimated");
  });
});

describe("daily leaderboard (memory store)", () => {
  it("ranks by score, then time; ties share a rank; only finished dailies count", async () => {
    const rows = [
      { playerId: "a", name: "Ana", score: 500, elapsedMs: 40_000, finishedAt: 3 },
      { playerId: "b", name: null, score: 500, elapsedMs: 30_000, finishedAt: 2 },
      { playerId: "c", name: "Cy", score: 300, elapsedMs: 10_000, finishedAt: 1 },
      { playerId: "d", name: "Di", score: 300, elapsedMs: 10_000, finishedAt: 4 },
    ];
    const b = rankBoard("2026-11-21", rows, "d", 2);
    expect(b.players).toBe(4);
    expect(b.top.map((e) => [e.rank, e.score])).toEqual([
      [1, 500],
      [2, 500],
    ]);
    expect(b.top[0].tag).toBe(anonTag("b"));
    expect(b.you).toMatchObject({ rank: 3, you: true, name: "Di" });
    expect(rankBoard("2026-11-21", rows, null, 50).top.map((e) => e.rank)).toEqual([1, 2, 3, 3]);
  });

  it("builds the board and day counts from real daily games", async () => {
    let t = Date.parse("2026-11-21T15:00:00Z");
    const store = createMemoryStore();
    const engine = createEngine({ store, now: () => t, random: () => 0, bank: async () => seedBank() });
    const players = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
    for (const [pi, p] of players.entries()) {
      const s = await engine.start(p, "daily");
      const rounds = pi === 2 ? 3 : 7; // third player abandons
      for (let i = 0; i < rounds; i++) {
        const { question } = await engine.serve(s.id, p);
        t += 1000 * (pi + 1);
        await engine.submit(s.id, p, i, seedBank().get(question!.id).answers[0].en);
      }
    }
    await store.setDisplayName(players[0], "Ana");
    const board = await store.leaderboard("2026-11-21", players[1], 50);
    expect(board.players).toBe(2);
    expect(board.top[0]).toMatchObject({ rank: 1, name: "Ana" }); // same score, faster
    expect(board.you).toMatchObject({ rank: 2, you: true });
    expect(JSON.stringify(board)).not.toContain(players[0]);

    const day = await store.dailyCounts("2026-11-21");
    const s0 = (await store.findDaily(players[0], "2026-11-21"))!;
    const first = s0.questionIds[0];
    expect(day[first].players).toBe(3);
    expect(day[first].bySlug[s0.submissions[0].answerId!]).toBe(3);
    const sum = summarize(seedBank(), s0, day);
    expect(sum.rounds[0].today).toEqual({ players: 3, same: 3 });
  });
});

describe("display names", () => {
  it.each([
    ["Ana", true],
    ["  Marie-Ève   T. ", true],
    ["Jean_Talon 42", true],
    ["a", false],
    ["x".repeat(21), false],
    ["<script>", false],
    ["visit www.spam.ca", false],
    ["Admin", false],
    ["Montréallion Official", false],
    ["sh1t", false],
    ["Tabarnak", false],
    ["Drapeau", true],
    ["Computer", true],
  ])("%s → %s", (raw, ok) => {
    expect(checkDisplayName(raw).ok).toBe(ok);
  });

  it("normalizes whitespace", () => {
    expect(checkDisplayName("  Marie-Ève   T. ")).toEqual({ ok: true, name: "Marie-Ève T." });
  });
});
