import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "@/lib/server/db";

const URL = process.env.TEST_DATABASE_URL;
const P = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe.skipIf(!URL)("answer double-check on Postgres", () => {
  let sql: Sql;
  let t = Date.parse("2026-11-23T15:00:00Z");
  const now = () => t;
  type Mods = {
    engine: typeof import("@/lib/game/engine");
    bank: typeof import("@/lib/game/bank");
    store: typeof import("@/lib/game/store-postgres");
  };
  let m: Mods;
  const g = globalThis as unknown as { __mlBank?: unknown; __mlSql?: unknown; __mlStore?: unknown };
  /** A fresh engine per "serverless instance": shared state lives only in Postgres. */
  const instance = () => m.engine.createEngine({ store: m.store.createPostgresStore(sql, m.bank.getBank), now });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    delete g.__mlSql;
    delete g.__mlBank;
    delete g.__mlStore;
    const db = await import("../../scripts/db.ts");
    const admin = db.connect(URL);
    await db.reset(admin, URL);
    await db.migrate(admin, () => {});
    await db.seed(admin, () => {});
    await admin.end();
    m = {
      engine: await import("@/lib/game/engine"),
      bank: await import("@/lib/game/bank"),
      store: await import("@/lib/game/store-postgres"),
    };
    sql = (await import("@/lib/server/db")).getSql()!;
  });

  afterAll(async () => {
    await sql?.end();
  });

  async function started() {
    const a = instance();
    const s = await a.start(P, "unlimited");
    const { question } = await a.serve(s.id, P);
    const answer = (await m.bank.getBank()).get(question!.id).answers[0].en;
    return { id: s.id, answer };
  }

  it("a check on one instance can be confirmed on another; nothing is consumed by the check", async () => {
    const { id, answer } = await started();
    const { view } = await instance().check(id, P, 0, answer);
    expect(view.status).toBe("match");
    const [row] = await sql<{ current_index: number; precheck: { key: string; answerIds: string[] } }[]>`
      select current_index, precheck from sessions where id = ${id}`;
    expect(row.current_index).toBe(0);
    expect(row.precheck.answerIds).toHaveLength(1);
    expect((await sql`select 1 from submissions where session_id = ${id}`).length).toBe(0);

    const { result } = await instance().submit(id, P, 0, answer, 0);
    expect(result).toMatchObject({ status: "correct" });
    const [after] = await sql<{ precheck: unknown }[]>`select precheck from sessions where id = ${id}`;
    expect(after.precheck).toBeNull(); // cleared when the question advances
  });

  it("concurrent checks never exceed MAX_CHECKS (row lock)", async () => {
    const { id } = await started();
    const views = await Promise.all(["aaaaaa", "bbbbbb", "cccccc", "dddddd", "eeeeee"].map((x) => instance().check(id, P, 0, x)));
    const counted = views.filter((v) => v.view.status !== "limit");
    expect(counted).toHaveLength(m.engine.MAX_CHECKS);
    const [row] = await sql<{ precheck: { checks: number } }[]>`select precheck from sessions where id = ${id}`;
    expect(row.precheck.checks).toBe(m.engine.MAX_CHECKS);
  });

  it("duplicate confirmations record exactly one submission", async () => {
    const { id, answer } = await started();
    await instance().check(id, P, 0, answer);
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => instance().submit(id, P, 0, answer, 0)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await sql`select 1 from submissions where session_id = ${id}`).length).toBe(1);
  });

  it("confirmation grace survives across instances and stays bounded", async () => {
    const { id, answer } = await started();
    t += m.engine.ANSWER_MS - 500;
    await instance().check(id, P, 0, answer);
    t += m.engine.GRACE_MS + 2_000; // past the base deadline
    expect((await instance().serve(id, P)).question!.index).toBe(0); // not auto-expired during grace
    const { result } = await instance().submit(id, P, 0, answer, 0);
    expect(result).toMatchObject({ status: "correct" });
  });
});
