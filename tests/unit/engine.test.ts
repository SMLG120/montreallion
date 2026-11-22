import { beforeEach, describe, expect, it } from "vitest";
import { ANSWER_MS, createEngine, GRACE_MS, GameError } from "@/lib/game/engine";
import { seedBank } from "@/lib/game/bank";

const getQuestion = (id: string) => seedBank().get(id);
const bank = async () => seedBank();
import { createMemoryStore } from "@/lib/game/store";

let t = Date.parse("2026-11-21T15:00:00Z");
const now = () => t;
let engine: ReturnType<typeof createEngine>;
const P = "11111111-1111-4111-8111-111111111111";

const firstAnswer = (qid: string) => getQuestion(qid).answers[0].en;

beforeEach(() => {
  t = Date.parse("2026-11-21T15:00:00Z");
  engine = createEngine({ store: createMemoryStore(), now, bank });
});

describe("game engine", () => {
  it("plays a full 7-question daily game with server scoring", async () => {
    const s = await engine.start(P, "daily");
    for (let i = 0; i < 7; i++) {
      const { question } = await engine.serve(s.id, P);
      expect(question!.index).toBe(i);
      expect(JSON.stringify(question)).not.toContain('"aliases"');
      t += 3000;
      const { result } = await engine.submit(s.id, P, i, i % 2 ? "definitely wrong" : firstAnswer(question!.id));
      expect(result.status).toBe(i % 2 ? "incorrect" : "correct");
    }
    const end = await engine.serve(s.id, P);
    expect(end.question).toBeNull();
    expect(end.session.finishedAt).not.toBeNull();
    expect(end.session.submissions.filter((x) => x.score > 0)).toHaveLength(4);
  });

  it("resumes the same daily session for the same player", async () => {
    const a = await engine.start(P, "daily");
    const b = await engine.start(P, "daily");
    expect(b.id).toBe(a.id);
    const other = await engine.start("22222222-2222-4222-8222-222222222222", "daily");
    expect(other.questionIds).toEqual(a.questionIds);
    expect(other.id).not.toBe(a.id);
  });

  it("does not reset the timer when a question is re-served", async () => {
    const s = await engine.start(P, "unlimited");
    const first = await engine.serve(s.id, P);
    t += 10_000;
    const again = await engine.serve(s.id, P);
    expect(again.deadline).toBe(first.deadline);
  });

  it("scores late answers as expired (0) and auto-expires abandoned questions", async () => {
    const s = await engine.start(P, "unlimited");
    const { question } = await engine.serve(s.id, P);
    t += ANSWER_MS + GRACE_MS + 1;
    const { result } = await engine.submit(s.id, P, 0, firstAnswer(question!.id));
    expect(result).toMatchObject({ status: "expired", score: 0 });

    await engine.serve(s.id, P);
    t += ANSWER_MS + GRACE_MS + 1;
    const next = await engine.serve(s.id, P);
    expect(next.session.submissions[1].status).toBe("expired");
    expect(next.question!.index).toBe(2);
  });

  it("enforces one answer per question, ownership, and ordering", async () => {
    const s = await engine.start(P, "unlimited");
    const { question } = await engine.serve(s.id, P);
    await expect(engine.submit(s.id, "33333333-3333-4333-8333-333333333333", 0, "x")).rejects.toBeInstanceOf(GameError);
    const [r1, r2] = await Promise.allSettled([
      engine.submit(s.id, P, 0, firstAnswer(question!.id)),
      engine.submit(s.id, P, 0, firstAnswer(question!.id)),
    ]);
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("rejected");
    await expect(engine.submit(s.id, P, 1, "x")).rejects.toMatchObject({ code: "not_served" });
  });

  it("asks for a retry on ambiguous input without consuming the question", async () => {
    const store = createMemoryStore();
    const e = createEngine({ store, now, bank });
    const s = await e.start(P, "unlimited");
    // Force a known question into slot 0 for this test.
    await store.mutate(s.id, (x) => {
      x.questionIds[0] = "habs-retired-number";
    });
    await e.serve(s.id, P);
    const r = await e.submit(s.id, P, 0, "Richard");
    expect(r.result).toEqual({ status: "retry" });
    const ok = await e.submit(s.id, P, 0, "Henri Richard");
    expect(ok.result).toMatchObject({ status: "correct", answerId: "henri-richard" });
  });
});
