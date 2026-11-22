import { describe, expect, it } from "vitest";
import { seedBank } from "@/lib/game/bank";
import { ANSWER_MS, GRACE_MS } from "@/lib/game/engine";
import {
  ACTIVE_MS,
  advance,
  createRoom,
  HOST_TIMEOUT_MS,
  join,
  leave,
  makeCode,
  CODE_RE,
  MAX_MEMBERS,
  PartyError,
  REVEAL_MS,
  start,
  submit,
  tick,
  touch,
  view,
  type RoomState,
} from "@/lib/game/party";
import { createMemoryPartyStore } from "@/lib/game/party-store";

const bank = seedBank();
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const T0 = Date.parse("2026-11-21T20:00:00Z");
const rightFor = (s: RoomState) => bank.get(s.questionIds[s.round]).answers[0].en;
const code = (e: unknown) => (e instanceof PartyError ? e.code : String(e));
const err = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return code(e);
  }
  return "no error";
};

function room(rounds = 3): RoomState {
  const s = createRoom("ABCDE", A, "Ana", { rounds, category: null }, T0);
  join(s, B, "Bo", T0);
  return s;
}

describe("party lobby", () => {
  it("makes valid codes", () => {
    let x = 0.123;
    for (let i = 0; i < 50; i++) expect(makeCode(() => (x = (x * 7.13) % 1))).toMatch(CODE_RE);
  });

  it("joins, rejoins, renames in lobby, rejects clashes, full rooms and late joins", () => {
    const s = room();
    expect(err(() => join(s, C, "  ana ".trim(), T0))).toBe("name_taken");
    expect(err(() => join(s, C, "ÁNA", T0))).toBe("name_taken");
    join(s, B, "Bea", T0 + 1);
    expect(s.members.map((m) => m.name)).toEqual(["Ana", "Bea"]);
    for (let i = s.members.length; i < MAX_MEMBERS; i++) join(s, `id-${i}`, `P${i}`, T0);
    expect(err(() => join(s, C, "Cy", T0))).toBe("full");
    const s2 = room();
    start(s2, A, bank, () => 0.5, T0);
    expect(err(() => join(s2, C, "Cy", T0))).toBe("started");
    join(s2, B, "Renamed", T0); // rejoin after start keeps seat, no rename
    expect(s2.members.find((m) => m.id === B)!.name).toBe("Bo");
  });

  it("only the host starts; questions and scores are frozen for the room", () => {
    const s = room(5);
    expect(err(() => start(s, B, bank, () => 0.5, T0))).toBe("not_host");
    start(s, A, bank, () => 0.5, T0);
    expect(s.questionIds).toHaveLength(5);
    expect(new Set(s.questionIds).size).toBe(5);
    expect(Object.keys(s.frozen!)).toEqual(expect.arrayContaining(s.questionIds));
    expect(err(() => start(s, A, bank, () => 0.5, T0))).toBe("started");
  });

  it("refuses tiny categories and caps rounds at the category size", () => {
    const s = createRoom("ABCDE", A, "Ana", { rounds: 10, category: "transit" }, T0);
    start(s, A, bank, () => 0.3, T0);
    const transit = bank.questions.filter((q) => q.category === "transit").length;
    expect(s.questionIds).toHaveLength(Math.min(10, transit));
    const tiny = (["food", "history", "festivals", "sports", "universities", "winter", "slang"] as const).find(
      (c) => bank.questions.filter((q) => q.category === c).length < 3,
    );
    if (tiny) expect(err(() => start(createRoom("ABCDE", A, "Ana", { rounds: 3, category: tiny }, T0), A, bank, () => 0.3, T0))).toBe("too_few_questions");
  });
});

describe("party rounds", () => {
  it("hides answers until the round closes, closes early when everyone answered, then reveals", () => {
    const s = room();
    start(s, A, bank, () => 0.5, T0);
    expect(submit(s, A, bank, 0, rightFor(s), T0 + 2000)).toEqual({ status: "locked" });
    const vb = view(s, bank, B, T0 + 2100);
    expect(vb.phase).toBe("question");
    expect(vb.reveal).toBeNull();
    expect(vb.members.find((m) => m.name === "Ana")).toMatchObject({ answered: true, score: 0 });
    expect(JSON.stringify(vb)).not.toContain(rightFor(s).slice(0, 6) === "" ? "§" : `"input":"${rightFor(s)}"`);
    expect(vb.you).toMatchObject({ answered: false, input: null });
    expect(err(() => submit(s, A, bank, 0, "again", T0 + 2200))).toBe("answered");

    submit(s, B, bank, 0, "definitely wrong", T0 + 3000);
    const va = view(s, bank, A, T0 + 3100);
    expect(va.phase).toBe("reveal");
    expect(va.revealUntil).toBe(T0 + 3000 + REVEAL_MS);
    expect(va.reveal!.answers.map((x) => [x.name, x.status])).toEqual([
      ["Ana", "correct"],
      ["Bo", "incorrect"],
    ]);
    expect(va.members[0]).toMatchObject({ name: "Ana", rank: 1, you: true, host: true });
    expect(va.members[0].score).toBeGreaterThanOrEqual(10);
    expect(JSON.stringify(va)).not.toMatch(/aaaaaaaa|bbbbbbbb/);
  });

  it("asks to be more specific on ambiguous input without consuming the answer", () => {
    const s = room();
    start(s, A, bank, () => 0.5, T0);
    const q = bank.get(s.questionIds[0]);
    if (q.ambiguous?.length) {
      expect(submit(s, A, bank, 0, q.ambiguous[0], T0 + 1000)).toEqual({ status: "retry" });
      expect(s.answers[0][A]).toBeUndefined();
    }
  });

  it("closes at the deadline with expired answers, then moves on after the reveal", () => {
    const s = room();
    start(s, A, bank, () => 0.5, T0);
    submit(s, A, bank, 0, rightFor(s), T0 + 1000);
    // B keeps polling (active) but never answers.
    touch(s, B, T0 + ANSWER_MS);
    expect(tick(s, T0 + ANSWER_MS + GRACE_MS)).toBe(false);
    expect(err(() => submit(s, B, bank, 0, "late", T0 + ANSWER_MS + GRACE_MS + 1))).toBe("closed");
    expect(tick(s, T0 + ANSWER_MS + GRACE_MS + 1)).toBe(true);
    expect(s.answers[0][B]).toMatchObject({ status: "expired", score: 0 });
    expect(s.roundClosedAt).toBe(T0 + ANSWER_MS);
    const t2 = T0 + ANSWER_MS + REVEAL_MS;
    expect(tick(s, t2)).toBe(true);
    expect(s.round).toBe(1);
    expect(s.roundStartedAt).toBe(t2);
    expect(err(() => submit(s, A, bank, 0, "x", t2 + 1))).toBe("wrong_round");
  });

  it("host can skip the reveal; the game finishes with a full history", () => {
    const s = room(3);
    start(s, A, bank, () => 0.5, T0);
    let t = T0;
    for (let r = 0; r < 3; r++) {
      expect(err(() => advance(s, A, t))).toBe("not_reveal");
      submit(s, A, bank, r, rightFor(s), (t += 1000));
      submit(s, B, bank, r, rightFor(s), (t += 1000));
      expect(err(() => advance(s, B, t))).toBe("not_host");
      advance(s, A, (t += 500));
    }
    expect(s.status).toBe("finished");
    const v = view(s, bank, B, t);
    expect(v.phase).toBe("finished");
    expect(v.history).toHaveLength(3);
    expect(v.history[0].answers.every((a) => a.same === 1)).toBe(true); // both gave the same answer
    expect(v.members[0].score).toBe(v.members[1].score);
    expect(v.members.map((m) => m.rank)).toEqual([1, 1]);
  });

  it("doesn't wait for away players, and hands host over when the host goes silent", () => {
    const s = room();
    join(s, C, "Cy", T0);
    start(s, A, bank, () => 0.5, T0);
    const t = T0 + ACTIVE_MS + 1000; // A and B stopped polling; only C is active
    touch(s, C, t);
    submit(s, C, bank, 0, rightFor(s), t);
    expect(s.roundClosedAt).toBe(t);
    expect(tick(s, T0 + HOST_TIMEOUT_MS + 1)).toBe(true);
    expect(s.hostId).toBe(C);
  });

  it("leaving: lobby seat freed, host reassigned; mid-game scores kept", () => {
    const s = room();
    leave(s, A, T0 + 10);
    expect(s.members.map((m) => m.name)).toEqual(["Bo"]);
    expect(s.hostId).toBe(B);
    const s2 = room();
    start(s2, A, bank, () => 0.5, T0);
    leave(s2, B, T0 + 1);
    expect(s2.members).toHaveLength(2);
  });
});

describe("memory party store", () => {
  it("creates unique codes and rolls back failed mutations", async () => {
    const store = createMemoryPartyStore(() => T0);
    expect(await store.create(room())).toBe(true);
    expect(await store.create(room())).toBe(false);
    await expect(
      store.mutate("ABCDE", (s) => {
        s.members.pop();
        throw new PartyError("not_host");
      }),
    ).rejects.toThrow(PartyError);
    expect((await store.get("ABCDE"))!.members).toHaveLength(2);
    expect(await store.get("ZZZZZ")).toBeNull();
  });
});
