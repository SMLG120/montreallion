import { z } from "zod";
import { checkDisplayName } from "@/lib/game/names";
import { defaultStore } from "@/lib/game/store";
import { errorResponse, getPlayerId, json, rateLimit, tooMany } from "@/lib/server/http";

/** GET /api/player — the caller's public display name (anonymous by default). */
export async function GET() {
  const id = await getPlayerId(false);
  if (!id) return json({ displayName: null });
  return json({ displayName: await (await defaultStore()).getDisplayName(id) });
}

const body = z.object({ displayName: z.string().max(100).nullable() });

/** PUT /api/player { displayName } — set or clear (null) the leaderboard name. */
export async function PUT(req: Request) {
  if (!(await rateLimit("player", 10))) return tooMany();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  let name: string | null = null;
  if (parsed.data.displayName !== null && parsed.data.displayName.trim() !== "") {
    const check = checkDisplayName(parsed.data.displayName);
    if (!check.ok) return json({ error: check.error }, 422);
    name = check.name;
  }
  try {
    const id = (await getPlayerId(true))!;
    const store = await defaultStore();
    await store.ensurePlayer(id);
    await store.setDisplayName(id, name);
    return json({ displayName: name });
  } catch (e) {
    return errorResponse(e);
  }
}
