import { z } from "zod";
import { engine } from "@/lib/game/engine";
import { errorResponse, getPlayerId, json, rateLimit, tooMany } from "@/lib/server/http";

const body = z.object({ index: z.number().int().min(0).max(50), answer: z.string().max(200) });

/**
 * POST /api/game/:id/check — double-check an answer before the final submission.
 * Never consumes the question and never returns ids, scores or rarity. Bounded per
 * question by MAX_CHECKS (server state, the enumeration bound) and per client IP by this
 * flood limit (2× the answer limit, since each answer is usually check + confirm).
 */
export async function POST(req: Request, ctx: RouteContext<"/api/game/[id]/check">) {
  if (!(await rateLimit("check", 120))) return tooMany();
  const { id } = await ctx.params;
  const playerId = await getPlayerId(false);
  if (!playerId) return json({ error: "forbidden" }, 403);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  try {
    const { view } = await engine.check(id, playerId, parsed.data.index, parsed.data.answer);
    return json({ ...view, serverNow: Date.now() });
  } catch (e) {
    return errorResponse(e);
  }
}
