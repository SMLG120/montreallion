import { z } from "zod";
import { getBank } from "@/lib/game/bank";
import { engine, revealFor } from "@/lib/game/engine";
import { errorResponse, getPlayerId, json, rateLimit, tooMany } from "@/lib/server/http";

const body = z.object({ index: z.number().int().min(0).max(50), answer: z.string().max(200) });

/** POST /api/game/:id/answer — validate and score one answer server-side. */
export async function POST(req: Request, ctx: RouteContext<"/api/game/[id]/answer">) {
  if (!(await rateLimit("answer", 60))) return tooMany();
  const { id } = await ctx.params;
  const playerId = await getPlayerId(false);
  if (!playerId) return json({ error: "forbidden" }, 403);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  try {
    const { session, result } = await engine.submit(id, playerId, parsed.data.index, parsed.data.answer);
    if (result.status === "retry") return json({ status: "retry" });
    return json({
      status: result.status,
      score: result.score,
      tier: result.tier,
      share: result.share,
      basis: result.basis,
      sample: result.sample,
      matchedBy: result.matchedBy,
      reveal: revealFor(await getBank(), session.frozenScores, result.questionId, result.answerId),
      runningScore: session.submissions.reduce((t, x) => t + x.score, 0),
      finished: session.finishedAt !== null,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
