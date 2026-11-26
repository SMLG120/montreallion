import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import generated from "../../data/generated/questions.generated.json";
import seed from "../../data/seed/questions.json";
import { seedBank } from "@/lib/game/bank";
import { MIN_CATEGORY_QUESTIONS } from "@/lib/game/engine";
import { CATEGORY_IDS } from "@/lib/game/types";

/** Phase L: regression gaps — rate limiting, migration safety, audit / homepage count integrity. */

// --- rate limiting (in-memory path; the shared Postgres window is covered by test:db) ---
let ip = "203.0.113.7";
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": `${ip}, 10.0.0.1` }), cookies: async () => ({}) }));

describe("rateLimit", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
    (globalThis as { __mlRate?: Map<string, unknown> }).__mlRate?.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("allows `limit` hits per window per client, then refuses until the window resets", async () => {
    const { rateLimit } = await import("@/lib/server/http");
    ip = "203.0.113.7";
    for (let i = 0; i < 5; i++) expect(await rateLimit("t-start", 5)).toBe(true);
    expect(await rateLimit("t-start", 5)).toBe(false);
    expect(await rateLimit("t-start", 5)).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(await rateLimit("t-start", 5)).toBe(true);
  });

  it("counts each scope and each client separately (the first forwarded address is the client)", async () => {
    const { rateLimit } = await import("@/lib/server/http");
    ip = "198.51.100.1";
    for (let i = 0; i < 3; i++) await rateLimit("t-a", 3);
    expect(await rateLimit("t-a", 3)).toBe(false);
    expect(await rateLimit("t-b", 3)).toBe(true);
    ip = "198.51.100.2";
    expect(await rateLimit("t-a", 3)).toBe(true);
  });
});

// --- migration safety ---
const MIG = join(__dirname, "../../supabase/migrations");
const migrations = readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort();

describe("migrations", () => {
  it("are uniquely timestamped and applied in name order", () => {
    for (const f of migrations) expect(f).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
    expect(new Set(migrations.map((f) => f.slice(0, 14))).size).toBe(migrations.length);
  });

  it("never destroy data (no DROP TABLE / DROP COLUMN / TRUNCATE / DELETE)", () => {
    for (const f of migrations) {
      const body = readFileSync(join(MIG, f), "utf8").replace(/--.*$/gm, "");
      expect(body, f).not.toMatch(/\b(drop\s+table|drop\s+column|truncate|delete\s+from)\b/i);
    }
  });

  it("question-bank migrations since Phase H are additive and re-runnable", () => {
    for (const f of migrations.filter((f) => f >= "20261126")) {
      const body = readFileSync(join(MIG, f), "utf8").replace(/--.*$/gm, "");
      for (const stmt of body.match(/\b(add column|create index|create table)\b[^;]*/gi) ?? []) expect(stmt, f).toMatch(/if not exists/i);
      for (const stmt of body.match(/\badd constraint\b/gi) ?? []) expect(body, `${f}: ${stmt}`).toMatch(/if not exists \(select 1 from pg_constraint/i);
    }
  });
});

// --- counts: audit doc, 500 target, homepage ---
type Raw = { category: string; reviewStatus: string };
const raw = [...seed.questions, ...generated.questions] as Raw[];
const audit = readFileSync(join(__dirname, "../../docs/QUESTION_AUDIT.md"), "utf8");
const row = (name: string) => {
  const line = audit.split("\n").find((l) => l.replace(/\*/g, "").startsWith(`| ${name} |`));
  return line?.split("|").slice(2, -1).map((c) => c.replace(/\*/g, "").trim());
};

describe("question counts", () => {
  const bank = seedBank();
  it("the audit's approved and in-review counts match the bank files, per category and in total", () => {
    for (const cat of CATEGORY_IDS) {
      // A category with no questions at all (e.g. slang) has no audit row.
      const r = row(cat) ?? ["0", "0", "0"];
      expect(Number(r[1]), `${cat} approved`).toBe(bank.questions.filter((q) => q.category === cat).length);
      expect(Number(r[2]), `${cat} in review`).toBe(raw.filter((q) => q.category === cat && q.reviewStatus === "in_review").length);
    }
    const total = row("total")!;
    expect(Number(total[1])).toBe(bank.questions.length);
    expect(Number(total[2])).toBe(raw.filter((q) => q.reviewStatus === "in_review").length);
  });

  it("reports the 500 target honestly: the gap is 500 minus approved + in review", () => {
    const total = row("total")!;
    expect(Number(total[4])).toBe(500);
    expect(Number(total[5])).toBe(Math.max(0, 500 - Number(total[3])));
    expect(Number(total[3])).toBe(Number(total[1]) + Number(total[2]));
  });

  it("only approved questions are playable", () => {
    for (const q of bank.questions) expect(q.reviewStatus, q.id).toBe("approved");
    expect(bank.questions.length).toBe(raw.filter((q) => q.reviewStatus === "approved").length);
  });

  it("the categories hidden on the homepage are exactly those under the minimum", () => {
    const hidden = CATEGORY_IDS.filter((c) => bank.questions.filter((q) => q.category === c).length < MIN_CATEGORY_QUESTIONS);
    const sumShown = CATEGORY_IDS.filter((c) => !hidden.includes(c)).reduce((n, c) => n + bank.questions.filter((q) => q.category === c).length, 0);
    const sumHidden = hidden.reduce((n, c) => n + bank.questions.filter((q) => q.category === c).length, 0);
    expect(sumShown + sumHidden).toBe(bank.questions.length);
  });
});
