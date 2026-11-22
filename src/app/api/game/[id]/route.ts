import { getBank } from "@/lib/game/bank";
import { engine, summarize } from "@/lib/game/engine";
import { defaultStore } from "@/lib/game/store";
import { errorResponse, json, rateLimit, tooMany } from "@/lib/server/http";

/** GET /api/game/:id — public results for a FINISHED session (shareable by unguessable id). */
export async function GET(_req: Request, ctx: RouteContext<"/api/game/[id]">) {
  if (!(await rateLimit("results", 60))) return tooMany();
  const { id } = await ctx.params;
  let s;
  try {
    s = await engine.get(id);
  } catch (e) {
    return errorResponse(e);
  }
  if (!s || s.finishedAt === null) return json({ error: "not_found" }, 404);
  const day = s.dateKey ? await (await defaultStore()).dailyCounts(s.dateKey) : null;
  return json(summarize(await getBank(), s, day));
}
