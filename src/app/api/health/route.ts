import { getBank } from "@/lib/game/bank";
import { dateKey, QUESTIONS_PER_GAME } from "@/lib/game/daily";
import { getSql } from "@/lib/server/db";
import { configProblems } from "@/lib/server/env";
import { json } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — deploy verification. Reports store kind, playable bank size and config problem names.
 * 503 when the database is unreachable, config is incomplete, or there are too few approved questions for a daily.
 */
export async function GET() {
  const problems = configProblems();
  let store: "postgres" | "memory" = "memory";
  let db: "ok" | "error" | "none" = "none";
  let approved = 0;
  try {
    const sql = getSql();
    if (sql) {
      store = "postgres";
      await sql`select 1`;
      db = "ok";
    }
    approved = (await getBank()).questions.length;
  } catch {
    if (store === "postgres") db = "error";
    problems.push("database unreachable");
  }
  if (approved < QUESTIONS_PER_GAME) problems.push(`only ${approved} approved questions (daily needs ${QUESTIONS_PER_GAME})`);
  const ok = problems.length === 0;
  return json({ ok, store, db, approvedQuestions: approved, today: dateKey(new Date()), commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null, problems }, ok ? 200 : 503);
}
