import { z } from "zod";
import { UUID_RE } from "@/lib/game/engine";
import { createAppeal } from "@/lib/server/appeals";
import { getSql } from "@/lib/server/db";
import { errorResponse, getPlayerId, json, rateLimit, tooMany } from "@/lib/server/http";

const body = z.object({
  sessionId: z.string().regex(UUID_RE),
  position: z.number().int().min(0).max(50),
  note: z.string().max(500).nullable().optional(),
});

/** POST /api/appeals — "my rejected answer is valid". Reviewed by an editor; scores are not changed retroactively. */
export async function POST(req: Request) {
  if (!(await rateLimit("appeal", 10))) return tooMany();
  const playerId = await getPlayerId(false);
  if (!playerId) return json({ error: "forbidden" }, 403);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  const sql = getSql();
  if (!sql) return json({ error: "unavailable" }, 503);
  try {
    const r = await createAppeal(sql, parsed.data.sessionId, playerId, parsed.data.position, parsed.data.note?.trim() ?? null);
    const status = { ok: 201, duplicate: 409, not_found: 404, not_appealable: 422 }[r];
    return json(r === "ok" ? { status: "open" } : { error: r }, status);
  } catch (e) {
    return errorResponse(e);
  }
}
