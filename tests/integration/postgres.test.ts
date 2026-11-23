import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "@/lib/server/db";
import { answerKeys } from "@/lib/game/match";
import { QUESTIONS_PER_GAME } from "@/lib/game/daily";
import type { CategoryId } from "@/lib/game/types";

const URL = process.env.TEST_DATABASE_URL;
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe.skipIf(!URL)("Postgres store (integration)", () => {
  let sql: Sql;
  let t = Date.parse("2026-11-21T15:00:00Z");
  const now = () => t;
  type Mods = {
    engine: typeof import("@/lib/game/engine");
    bank: typeof import("@/lib/game/bank");
    store: typeof import("@/lib/game/store-postgres");
    rate: typeof import("@/lib/server/rate-limit-pg");
  };
  let m: Mods;
  let engine: ReturnType<Mods["engine"]["createEngine"]>;

  const g = globalThis as unknown as { __mlBank?: unknown; __mlSql?: unknown; __mlStore?: unknown };
  const answerFor = (qid: string) => m.bank.seedBank().get(qid).answers[0].en;
  const smallCategory = () => {
    const sizes = new Map<CategoryId, number>();
    for (const q of m.bank.seedBank().questions) sizes.set(q.category, (sizes.get(q.category) ?? 0) + 1);
    const fits = [...sizes].filter(([, n]) => n >= m.engine.MIN_CATEGORY_QUESTIONS && n <= QUESTIONS_PER_GAME);
    if (!fits.length) throw new Error("no category small enough to force a repeat");
    return fits.sort((x, y) => x[1] - y[1])[0][0];
  };

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
      rate: await import("@/lib/server/rate-limit-pg"),
    };
    sql = (await import("@/lib/server/db")).getSql()!;
    engine = m.engine.createEngine({ store: m.store.createPostgresStore(sql, m.bank.getBank), now });
  });

  afterAll(async () => {
    await sql?.end();
  });

  it("loads the same approved bank from the database as the seed file", async () => {
    const db = await m.bank.getBank();
    const seed = m.bank.seedBank();
    // The DB version lists every bank file that contributed an approved question, the same files the bundled bank lists.
    expect(db.version.replace(/^db:/, "").split("+").sort()).toEqual(seed.version.split("+").sort());
    expect(db.questions.map((q) => q.id).sort()).toEqual(seed.questions.map((q) => q.id).sort());
    for (const q of seed.questions) {
      const dq = db.get(q.id);
      expect(dq.answers.map((a) => a.id).sort()).toEqual(q.answers.map((a) => a.id).sort());
      // Same normalized match keys (the seeder drops aliases that duplicate a label's key).
      for (const a of q.answers) {
        expect(answerKeys(dq.answers.find((x) => x.id === a.id)!).sort()).toEqual(answerKeys(a).sort());
      }
      expect(db.answerDbId(q.id, q.answers[0].id)).toBeTypeOf("number");
    }
  });

  it("plays a full daily game with transactional persistence and answer stats", async () => {
    const s = await engine.start(P1, "daily");
    for (let i = 0; i < 7; i++) {
      const { question } = await engine.serve(s.id, P1);
      t += 2000;
      await engine.submit(s.id, P1, i, i === 2 ? "nope nope" : answerFor(question!.id));
    }
    const [row] = await sql`select current_index, total_score, finished_at from sessions where id = ${s.id}`;
    const subs = await sql`select position, status, score, answer_id from submissions where session_id = ${s.id} order by position`;
    expect(subs.map((x) => x.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(subs.filter((x) => x.status === "correct")).toHaveLength(6);
    expect(row.current_index).toBe(7);
    expect(row.finished_at).not.toBeNull();
    expect(row.total_score).toBe(subs.reduce((t, x) => t + x.score, 0));
    const [stats] = await sql`select sum(attempts)::int as attempts, sum(correct)::int as correct from question_stats`;
    expect(stats).toEqual({ attempts: 7, correct: 6 });
    const reloaded = await engine.get(s.id);
    expect(reloaded!.submissions.filter((x) => x.answerId)).toHaveLength(6);
  });

  it("allows exactly one answer when two submits race (row lock + unique position)", async () => {
    const s = await engine.start(P2, "unlimited");
    const { question } = await engine.serve(s.id, P2);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => engine.submit(s.id, P2, 0, answerFor(question!.id))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: expect.stringMatching(/out_of_order|not_served/) });
    const [{ n }] = await sql`select count(*)::int as n from submissions where session_id = ${s.id}`;
    expect(n).toBe(1);
  });

  it("creates one daily session per player even under concurrent starts", async () => {
    const P3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const sessions = await Promise.all(Array.from({ length: 5 }, () => engine.start(P3, "daily")));
    expect(new Set(sessions.map((x) => x.id)).size).toBe(1);
    const [{ n }] = await sql`select count(*)::int as n from sessions where player_id = ${P3}`;
    expect(n).toBe(1);
    const [{ d }] = await sql`select count(*)::int as d from daily_challenges`;
    expect(d).toBe(1);
  });

  it("freezes daily scoring even if rarity weights change mid-day", async () => {
    const P4 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const s = await engine.start(P4, "daily");
    const qid = s.questionIds[0];
    const top = m.bank.seedBank().get(qid).answers.slice().sort((a, b) => b.est - a.est)[0];
    const frozen = s.frozenScores![qid][top.id].score;
    // Make the most common answer suddenly very rare, and drop the bank cache.
    await sql`update answers set est_weight = 1 where question_id = ${qid} and slug = ${top.id}`;
    delete g.__mlBank;
    await engine.serve(s.id, P4);
    const { result } = await engine.submit(s.id, P4, 0, top.en);
    expect(result).toMatchObject({ status: "correct", score: frozen });
    await sql`update answers set est_weight = ${top.est} where question_id = ${qid} and slug = ${top.id}`;
    delete g.__mlBank;
  });

  it("rejects foreign players and malformed ids", async () => {
    const s = await engine.start(P1, "unlimited");
    await expect(engine.serve(s.id, P2)).rejects.toMatchObject({ code: "forbidden" });
    await expect(engine.serve("not-a-uuid", P1)).rejects.toMatchObject({ code: "not_found" });
    expect(await engine.get("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("counts requests per key in a shared fixed window", async () => {
    const counts = [];
    for (let i = 0; i < 3; i++) counts.push(await m.rate.pgRateHit(sql, "test:key", 60));
    expect(counts).toEqual([1, 2, 3]);
    await sql`update rate_limits set window_start = now() - interval '2 minutes' where key = 'test:key'`;
    expect(await m.rate.pgRateHit(sql, "test:key", 60)).toBe(1);
  });

  it("denies client roles (anon/authenticated) access to game data via RLS and grants", async () => {
    await sql.begin(async (tx) => {
      await tx`grant usage on schema public to anon`;
      await tx`set local role anon`;
      const cats = await tx`select id from categories`;
      expect(cats.length).toBe(10);
    });
    for (const table of ["answers", "answer_aliases", "sessions", "submissions", "players", "questions"]) {
      await expect(
        sql.begin(async (tx) => {
          await tx`set local role anon`;
          await tx.unsafe(`select * from ${table} limit 1`);
        }),
      ).rejects.toThrow(/permission denied/);
    }
    // Even if someone later grants SELECT by mistake, RLS (no policies) still returns nothing.
    await sql`grant select on answers to authenticated`;
    await sql`grant usage on schema public to authenticated`;
    const rows = await sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      return tx`select * from answers`;
    });
    expect(rows.length).toBe(0);
    await sql`revoke select on answers from authenticated`;
  });

  it("counts distinct players per answer (replays don't inflate rarity) and loads them into the bank", async () => {
    const st = m.store.createPostgresStore(sql, m.bank.getBank);
    const unlimited = m.engine.createEngine({ store: st, now, random: () => 0 });
    const P3 = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
    const played: { qid: string; slug: string }[] = [];
    for (let game = 0; game < 2; game++) {
      // A category small enough to fit in one game forces a repeat even with no-repeat picking.
      const s = await unlimited.start(P3, "unlimited", { category: smallCategory() });
      const { question } = await unlimited.serve(s.id, P3);
      t += 2000;
      const { result } = await unlimited.submit(s.id, P3, 0, answerFor(question!.id));
      if (result.status !== "correct") throw new Error("expected correct");
      played.push({ qid: question!.id, slug: result.answerId! });
    }
    expect(played[0]).toEqual(played[1]); // same deterministic question + answer twice
    const [row] = await sql<{ correct_count: number; players: number }[]>`
      select st.correct_count, st.players from answer_stats st join answers a on a.id = st.answer_id
      where a.question_id = ${played[0].qid} and a.slug = ${played[0].slug}`;
    const [{ c }] = await sql<{ c: number }[]>`
      select count(*)::int as c from answer_players ap join answers a on a.id = ap.answer_id
      where a.question_id = ${played[0].qid} and a.slug = ${played[0].slug}`;
    expect(row.players).toBe(c);
    expect(row.correct_count).toBeGreaterThanOrEqual(row.players + 1);

    delete g.__mlBank;
    const bank = await m.bank.getBank();
    expect(bank.rarityModel).toBe("observed-v1");
    const counts = bank.counts(played[0].qid)!;
    expect(counts.bySlug[played[0].slug]).toBe(row.players);
    expect(counts.n).toBe(Object.values(counts.bySlug).reduce((a, b) => a + b, 0));
    // Below MIN_SAMPLE the live score is still the estimate.
    expect(m.engine.scoreFor(bank, null, played[0].qid, played[0].slug).basis).toBe("estimated");
  });

  it("ranks the daily leaderboard in SQL with ties, names and the caller's row; counts the day's answers", async () => {
    t = Date.parse("2026-11-25T15:00:00Z");
    const st = m.store.createPostgresStore(sql, m.bank.getBank);
    const e = m.engine.createEngine({ store: st, now });
    const ps = ["dddddddd-dddd-4ddd-8ddd-dddddddddddd", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "ffffffff-ffff-4fff-8fff-ffffffffffff"];
    for (const [pi, p] of ps.entries()) {
      const s = await e.start(p, "daily");
      const rounds = pi === 2 ? 2 : 7;
      for (let i = 0; i < rounds; i++) {
        const { question } = await e.serve(s.id, p);
        t += 1000 * (pi + 1);
        await e.submit(s.id, p, i, i === 6 && pi === 1 ? "nope" : answerFor(question!.id));
      }
    }
    await st.setDisplayName(ps[1], "Émile");
    expect(await st.getDisplayName(ps[1])).toBe("Émile");
    const board = await st.leaderboard("2026-11-25", ps[1], 1);
    expect(board.players).toBe(2); // the abandoned ride isn't ranked
    expect(board.top).toHaveLength(1);
    expect(board.top[0]).toMatchObject({ rank: 1, you: false, name: null });
    expect(board.you).toMatchObject({ rank: 2, you: true, name: "Émile" });
    expect(board.top[0].tag).toMatch(/^\d{4}$/);
    expect(JSON.stringify(board)).not.toMatch(/dddddddd|eeeeeeee/);

    const day = await st.dailyCounts("2026-11-25");
    const s0 = (await st.findDaily(ps[0], "2026-11-25"))!;
    expect(day[s0.questionIds[0]].players).toBe(3);
    expect(day[s0.questionIds[6]].players).toBe(2);
    expect(day[s0.questionIds[6]].bySlug[s0.submissions[6].answerId!]).toBe(1);

    const [sess] = await sql<{ total_elapsed_ms: number; basis: string }[]>`
      select s.total_elapsed_ms, (select rarity_basis from submissions where session_id = s.id and position = 0) as basis
      from sessions s where s.id = ${s0.id}`;
    expect(sess.total_elapsed_ms).toBe(7000);
    expect(sess.basis).toBe("estimated");
  });

  it("admin reviews apply, refuse stale content, survive reseeding, and export to the ETL decisions file", async () => {
    const admin = await import("@/lib/server/admin-data");
    const db = await import("../../scripts/db.ts");
    const [gen] = await sql<{ id: string; content_hash: string }[]>`
      select id, content_hash from questions where id like 'gen-%' and review_status = 'in_review' order by id limit 1`;
    expect(gen).toBeTruthy();
    expect(await admin.reviewQuestion(sql, gen.id, "approved", "Tester", "", "not-the-hash")).toBe("stale");
    expect(await admin.reviewQuestion(sql, gen.id, "approved", "Tester", "checked vs source", gen.content_hash)).toBe("ok");
    expect((await m.bank.getBank()).questions.some((q) => q.id === gen.id)).toBe(true); // cache invalidated

    const quiet = () => {};
    await db.seed(sql, quiet);
    const [after] = await sql<{ review_status: string }[]>`select review_status from questions where id = ${gen.id}`;
    expect(after.review_status).toBe("approved");

    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const file = join(mkdtempSync(join(tmpdir(), "ml-")), "decisions.json");
    writeFileSync(file, "{}");
    await db.exportReviews(sql, quiet, file);
    const exported = JSON.parse(readFileSync(file, "utf8"));
    const [{ etl }] = await sql<{ etl: string }[]>`select generator->>'contentHash' as etl from questions where id = ${gen.id}`;
    expect(exported[gen.id]).toMatchObject({ status: "approved", reviewer: "Tester", contentHash: etl, note: "checked vs source" });

    // A review pinned to different content no longer applies after reseeding.
    await sql`insert into question_reviews (question_id, status, reviewer, content_hash) values (${gen.id}, 'rejected', 'Old', 'other-hash')`;
    await db.seed(sql, quiet);
    const [reset] = await sql<{ review_status: string }[]>`select review_status from questions where id = ${gen.id}`;
    expect(reset.review_status).toBe("in_review");
    m.bank.invalidateBank();
  });

  it("appeals: only own finished incorrect answers; accepting as alias makes the input match and survives reseeding", async () => {
    const appeals = await import("@/lib/server/appeals");
    const admin = await import("@/lib/server/admin-data");
    const db = await import("../../scripts/db.ts");
    const { matchAnswer } = await import("@/lib/game/match");
    t = Date.parse("2026-11-26T15:00:00Z");
    const st = m.store.createPostgresStore(sql, m.bank.getBank);
    const e = m.engine.createEngine({ store: st, now });
    const P = "abababab-abab-4bab-8bab-abababababab";
    const s = await e.start(P, "daily");
    const WEIRD = "Zzyzx Qwerty Plonk";
    for (let i = 0; i < 7; i++) {
      const { question } = await e.serve(s.id, P);
      t += 1000;
      await e.submit(s.id, P, i, i === 0 ? WEIRD : answerFor(question!.id));
    }
    expect(await appeals.createAppeal(sql, s.id, "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd", 0, null)).toBe("not_found");
    expect(await appeals.createAppeal(sql, s.id, P, 1, null)).toBe("not_appealable"); // correct answer
    expect(await appeals.createAppeal(sql, s.id, P, 0, "it's a real place")).toBe("ok");
    expect(await appeals.createAppeal(sql, s.id, P, 0, null)).toBe("duplicate");
    expect(await appeals.appealsForSession(sql, s.id, P)).toEqual({ 0: "open" });

    const open = await admin.listAppeals(sql, "open");
    const ap = open.find((a) => a.input === WEIRD)!;
    expect(ap.key).toBe("zzyzxqwertyplonk");
    expect(ap.nearest.length).toBeGreaterThan(0);
    const qid = s.questionIds[0];
    const target = m.bank.seedBank().get(qid).answers.at(-1)!.id;
    expect(await admin.resolveAppeal(sql, ap.id, "alias", "Tester", "", "no-such-answer")).toBe("bad_answer");
    expect(await admin.resolveAppeal(sql, ap.id, "alias", "Tester", "verified", target)).toBe("ok");
    expect(await admin.resolveAppeal(sql, ap.id, "rejected", "Tester", "", undefined)).toBe("not_open");
    expect(await appeals.appealsForSession(sql, s.id, P)).toEqual({ 0: "accepted" });

    const matched = () => m.bank.getBank().then((b) => matchAnswer(b.get(qid), WEIRD));
    expect(await matched()).toMatchObject({ kind: "match", answerId: target });
    await db.seed(sql, () => {});
    m.bank.invalidateBank();
    expect(await matched()).toMatchObject({ kind: "match", answerId: target });
    // Past score is unchanged.
    const [sub] = await sql<{ status: string; score: number }[]>`select status::text, score from submissions where session_id = ${s.id} and position = 0`;
    expect(sub).toEqual({ status: "incorrect", score: 0 });
  });

  it("returns a player's recent question ids for no-repeat Unlimited", async () => {
    const st = m.store.createPostgresStore(sql, m.bank.getBank);
    const recent = await st.recentQuestionIds("abababab-abab-4bab-8bab-abababababab", 4);
    expect(recent).toHaveLength(7);
  });

  it("party rooms: jsonb state under row locks survives concurrent answers and rejects duplicate codes", async () => {
    const party = await import("@/lib/game/party");
    const { createPostgresPartyStore } = await import("@/lib/game/party-store");
    const store = createPostgresPartyStore(sql);
    const bank = m.bank.seedBank();
    const T = Date.now();
    const ids = ["11111111-0000-4000-8000-000000000001", "11111111-0000-4000-8000-000000000002", "11111111-0000-4000-8000-000000000003"];
    const room = party.createRoom("QWE23", ids[0], "Ana", { rounds: 3, category: null }, T);
    expect(await store.create(room)).toBe(true);
    expect(await store.create(room)).toBe(false);
    await store.mutate("QWE23", (s) => {
      party.join(s, ids[1], "Bo", T);
      party.join(s, ids[2], "Cy", T);
      party.start(s, ids[0], bank, () => 0.4, T);
    });
    const s0 = (await store.get("QWE23"))!;
    const right = bank.get(s0.questionIds[0]).answers[0].en;
    // Three simultaneous answers: all recorded, round closes exactly once.
    await Promise.all(ids.map((id, i) => store.mutate("QWE23", (s) => party.submit(s, id, bank, 0, i === 2 ? "nope" : right, T + 1000 + i))));
    const s1 = (await store.get("QWE23"))!;
    expect(Object.keys(s1.answers[0])).toHaveLength(3);
    expect(s1.roundClosedAt).not.toBeNull();
    // A duplicate submit is rejected and changes nothing.
    await expect(store.mutate("QWE23", (s) => party.submit(s, ids[0], bank, 0, right, T + 2000))).rejects.toThrow(party.PartyError);
    const v = party.view(s1, bank, ids[1], T + 3000);
    expect(v.phase).toBe("reveal");
    expect(v.reveal!.answers.filter((a) => a.status === "correct")).toHaveLength(2);
    const [{ status }] = await sql<{ status: string }[]>`select status from party_rooms where code = 'QWE23'`;
    expect(status).toBe("playing");
    expect(await store.get("ZZZZ2")).toBeNull();
  });
});
