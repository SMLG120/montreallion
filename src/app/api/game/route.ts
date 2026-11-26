import { z } from "zod";
import { engine } from "@/lib/game/engine";
import { CATEGORY_IDS } from "@/lib/game/types";
import { errorResponse, getPlayerId, json, rateLimit, tooMany } from "@/lib/server/http";

const body = z.object({
  mode: z.enum(["daily", "unlimited"]),
  category: z.enum(CATEGORY_IDS).optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  requestId: z.uuid().optional(),
});

/** POST /api/game — start (or resume today's daily) session. */
export async function POST(req: Request) {
  if (!(await rateLimit("start", 20))) return tooMany();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  try {
    const playerId = (await getPlayerId(true))!;
    // Category and difficulty filters apply to Unlimited only; the daily line is the same for everyone.
    const s = await engine.start(playerId, parsed.data.mode, {
      ...(parsed.data.mode === "unlimited" ? { category: parsed.data.category, difficulty: parsed.data.difficulty } : {}),
      requestId: parsed.data.requestId,
    });
    return json({ sessionId: s.id, mode: s.mode, dateKey: s.dateKey, total: s.questionIds.length, index: s.index, finished: s.finishedAt !== null });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * GET /api/game?mode=daily | ?session=<id> — the caller's existing ride, read-only.
 * Never creates a session or serves a question, so pre-game screens can't start a clock.
 */
export async function GET(req: Request) {
  if (!(await rateLimit("peek", 60))) return tooMany();
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode");
  const session = url.searchParams.get("session");
  if (mode !== "daily" && !session) return json({ error: "bad_request" }, 400);
  const playerId = await getPlayerId(false);
  if (!playerId) return json({ ride: null, serverNow: Date.now() });
  try {
    const ride = await engine.peek(playerId, session ? { id: session } : { mode: "daily" });
    return json({ ride, serverNow: Date.now() });
  } catch (e) {
    return errorResponse(e);
  }
}
