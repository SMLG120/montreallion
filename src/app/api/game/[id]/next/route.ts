import { engine } from "@/lib/game/engine";
import { errorResponse, getPlayerId, json, rateLimit, tooMany } from "@/lib/server/http";

/** POST /api/game/:id/next — serve the current question and start (or keep) its server-side timer. */
export async function POST(_req: Request, ctx: RouteContext<"/api/game/[id]/next">) {
  if (!(await rateLimit("next", 120))) return tooMany();
  const { id } = await ctx.params;
  const playerId = await getPlayerId(false);
  if (!playerId) return json({ error: "forbidden" }, 403);
  try {
    const { session, question, deadline } = await engine.serve(id, playerId);
    return json({
      index: session.index,
      total: session.questionIds.length,
      finished: session.finishedAt !== null,
      runningScore: session.submissions.reduce((t, x) => t + x.score, 0),
      history: session.submissions.map((x) => ({ status: x.status, score: x.score, tier: x.tier })),
      question,
      deadline,
      serverNow: Date.now(),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
