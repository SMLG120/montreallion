import "server-only";
import type { Sql } from "./db";

export type AppealCreate = "ok" | "not_found" | "not_appealable" | "duplicate";

/** A player may appeal an INCORRECT, non-empty answer in one of their own FINISHED sessions, once. */
export async function createAppeal(sql: Sql, sessionId: string, playerId: string, position: number, note: string | null): Promise<AppealCreate> {
  const [sub] = await sql<{ id: number; status: string; input: string; finished: boolean }[]>`
    select sub.id, sub.status::text as status, sub.input, s.finished_at is not null as finished
    from submissions sub join sessions s on s.id = sub.session_id
    where s.id = ${sessionId} and s.player_id = ${playerId} and sub.position = ${position}`;
  if (!sub) return "not_found";
  if (!sub.finished || sub.status !== "incorrect" || !sub.input.trim()) return "not_appealable";
  const ins = await sql`insert into appeals (submission_id, player_id, note) values (${sub.id}, ${playerId}, ${note || null})
                        on conflict (submission_id) do nothing returning id`;
  return ins.length ? "ok" : "duplicate";
}

/** position → appeal status, for the owner's results page. */
export async function appealsForSession(sql: Sql, sessionId: string, playerId: string): Promise<Record<number, string>> {
  const rows = await sql<{ position: number; status: string }[]>`
    select sub.position, ap.status::text as status from appeals ap join submissions sub on sub.id = ap.submission_id
    join sessions s on s.id = sub.session_id where s.id = ${sessionId} and s.player_id = ${playerId}`;
  return Object.fromEntries(rows.map((r) => [r.position, r.status]));
}
