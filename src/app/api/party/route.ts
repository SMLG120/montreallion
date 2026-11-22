import { z } from "zod";
import { checkDisplayName } from "@/lib/game/names";
import { PARTY_ROUNDS } from "@/lib/game/party";
import { createParty } from "@/lib/game/party-service";
import { CATEGORY_IDS } from "@/lib/game/types";
import { errorResponse, getPlayerId, json, rateLimit, tooMany } from "@/lib/server/http";

const body = z.object({
  name: z.string().max(100),
  rounds: z.number().int().refine((n) => (PARTY_ROUNDS as readonly number[]).includes(n)),
  category: z.enum(CATEGORY_IDS).nullable().optional(),
});

/** POST /api/party — create a room; the caller becomes host. */
export async function POST(req: Request) {
  if (!(await rateLimit("party-create", 6))) return tooMany();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  const name = checkDisplayName(parsed.data.name);
  if (!name.ok) return json({ error: name.error }, 422);
  try {
    const playerId = (await getPlayerId(true))!;
    const code = await createParty(playerId, name.name, { rounds: parsed.data.rounds, category: parsed.data.category ?? null });
    return json({ code }, 201);
  } catch (e) {
    return errorResponse(e);
  }
}
