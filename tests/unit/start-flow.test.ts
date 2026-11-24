import { beforeEach, describe, expect, it } from "vitest";
import { ANSWER_MS, createEngine, GRACE_MS, GameError } from "@/lib/game/engine";
import { seedBank } from "@/lib/game/bank";
import { createMemoryStore } from "@/lib/game/store";

let t = Date.parse("2026-11-21T15:00:00Z");
const now = () => t;
let engine: ReturnType<typeof createEngine>;
const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  t = Date.parse("2026-11-21T15:00:00Z");
  engine = createEngine({ store: createMemoryStore(), now, bank: async () => seedBank() });
});

describe("pre-game start flow", () => {
  it("peek never creates a ride or starts a clock", async () => {
    expect(await engine.peek(P, { mode: "daily" })).toBeNull();
    expect(await engine.peek(P, { mode: "daily" })).toBeNull();
    const s = await engine.start(P, "daily");
    expect(s.servedAt).toBeNull(); // Start Game creates the ride; the timer only starts on the first serve
    const v = await engine.peek(P, { mode: "daily" });
    expect(v).toMatchObject({ sessionId: s.id, index: 0, live: false, finished: false, runningScore: 0 });
    t += 60_000;
    expect((await engine.get(s.id))!.servedAt).toBeNull();
  });

  it("first serve starts the clock exactly once; peek reports it live, then not after the deadline", async () => {
    const s = await engine.start(P, "unlimited");
    const a = await engine.serve(s.id, P);
    t += 5_000;
    expect(await engine.peek(P, { id: s.id })).toMatchObject({ live: true, index: 0 });
    const b = await engine.serve(s.id, P); // refresh / repeated click
    expect(b.deadline).toBe(a.deadline);
    t += ANSWER_MS + GRACE_MS + 1;
    // The lapsed stop is recorded as expired, so the lobby offers the next one (never a stop that can't be answered).
    const v = await engine.peek(P, { id: s.id });
    expect(v).toMatchObject({ live: false, index: 1, finished: false });
    expect(v!.history).toEqual([{ status: "expired", score: 0, tier: null }]);
    // Peek still doesn't start the next clock.
    expect((await engine.get(s.id))!.servedAt).toBeNull();
  });

  it("peek after the last question lapsed reports the ride finished", async () => {
    const s = await engine.start(P, "daily");
    for (let i = 0; i < s.questionIds.length; i++) {
      await engine.serve(s.id, P);
      t += ANSWER_MS + GRACE_MS + 1;
    }
    const v = await engine.peek(P, { mode: "daily" });
    expect(v).toMatchObject({ finished: true, live: false, index: s.questionIds.length });
    expect((await engine.get(s.id))!.finishedAt).not.toBeNull();
  });

  it("peek hides other players' rides and bad ids", async () => {
    const s = await engine.start(P, "unlimited");
    expect(await engine.peek(Q, { id: s.id })).toBeNull();
    expect(await engine.peek(P, { id: "nope" })).toBeNull();
  });

  it("requestId makes Start idempotent (double click / retry → one ride)", async () => {
    const [a, b] = await Promise.all([engine.start(P, "unlimited", { requestId: R }), engine.start(P, "unlimited", { requestId: R })]);
    expect(a.id).toBe(R);
    expect(b.id).toBe(R);
    const c = await engine.start(P, "unlimited", { requestId: R });
    expect(c.questionIds).toEqual(a.questionIds);
  });

  it("requestId cannot claim another player's ride or switch modes", async () => {
    await engine.start(P, "unlimited", { requestId: R });
    await expect(engine.start(Q, "unlimited", { requestId: R })).rejects.toBeInstanceOf(GameError);
    await expect(engine.start(P, "daily", { requestId: R })).rejects.toBeInstanceOf(GameError);
  });

  it("daily stays one ranked attempt per day even with distinct requestIds", async () => {
    const a = await engine.start(P, "daily", { requestId: R });
    const b = await engine.start(P, "daily", { requestId: "44444444-4444-4444-8444-444444444444" });
    expect(b.id).toBe(a.id);
  });

  it("a daily Start retried after midnight starts today's ride, not yesterday's", async () => {
    t = Date.parse("2026-11-21T23:59:58-05:00");
    const y = await engine.start(P, "daily", { requestId: R });
    t = Date.parse("2026-11-22T00:00:05-05:00");
    const d = await engine.start(P, "daily", { requestId: R });
    expect(d.id).not.toBe(y.id);
    expect(d.dateKey).not.toBe(y.dateKey);
  });
});
