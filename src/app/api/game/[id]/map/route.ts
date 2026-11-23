import { getBank } from "@/lib/game/bank";
import { engine } from "@/lib/game/engine";
import { sessionPins } from "@/lib/game/answer-geo";
import { errorResponse, json, rateLimit, tooMany } from "@/lib/server/http";

/**
 * GET /api/game/:id/map — map pins for a FINISHED session (same visibility as its public results page).
 * Only the answers the results page already reveals (the player's match, 3 most common, 2 rarest) are returned,
 * with labels and positions; never ids, scores, rarity or any other answer of the question.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/game/[id]/map">) {
  if (!(await rateLimit("results-map", 60))) return tooMany();
  const { id } = await ctx.params;
  let s;
  try {
    s = await engine.get(id);
  } catch (e) {
    return errorResponse(e);
  }
  if (!s || s.finishedAt === null) return json({ error: "not_found" }, 404);
  return json(sessionPins(await getBank(), s));
}
