import { z } from "zod";
import { engine } from "@/lib/game/engine";
import { CATEGORY_IDS } from "@/lib/game/types";
import { errorResponse, getPlayerId, json, rateLimit, tooMany } from "@/lib/server/http";

const body = z.object({ mode: z.enum(["daily", "unlimited"]), category: z.enum(CATEGORY_IDS).optional() });

/** POST /api/game — start (or resume today's daily) session. */
export async function POST(req: Request) {
  if (!(await rateLimit("start", 20))) return tooMany();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  try {
    const playerId = (await getPlayerId(true))!;
    // Category filters apply to Unlimited only; the daily line is the same for everyone.
    const s = await engine.start(playerId, parsed.data.mode, parsed.data.mode === "unlimited" ? { category: parsed.data.category } : {});
    return json({ sessionId: s.id, mode: s.mode, dateKey: s.dateKey, total: s.questionIds.length, index: s.index, finished: s.finishedAt !== null });
  } catch (e) {
    return errorResponse(e);
  }
}
