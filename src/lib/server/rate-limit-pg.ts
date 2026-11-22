import type { Sql } from "./db";

/** Atomic fixed-window counter in Postgres. Returns the request count in the current window. */
export async function pgRateHit(sql: Sql, key: string, windowSecs: number): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    insert into rate_limits (key, window_start, count) values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when rate_limits.window_start < now() - make_interval(secs => ${windowSecs}) then 1 else rate_limits.count + 1 end,
      window_start = case when rate_limits.window_start < now() - make_interval(secs => ${windowSecs}) then now() else rate_limits.window_start end
    returning count`;
  if (Math.random() < 0.01) void sql`delete from rate_limits where window_start < now() - interval '1 hour'`.catch(() => {});
  return row.count;
}
