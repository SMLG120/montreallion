import { z } from "zod";
import { checkDisplayName } from "@/lib/game/names";
import { CODE_RE, PartyError } from "@/lib/game/party";
import { actOnParty, getPartyView, viewTag } from "@/lib/game/party-service";
import { errorResponse, getPlayerId, json, rateLimit, tooMany } from "@/lib/server/http";

const PARTY_STATUS: Record<PartyError["code"], number> = {
  not_found: 404,
  not_member: 403,
  not_host: 403,
  started: 409,
  full: 409,
  name_taken: 409,
  not_playing: 409,
  wrong_round: 409,
  closed: 409,
  answered: 409,
  too_few_questions: 422,
  not_reveal: 409,
};

function partyError(e: unknown) {
  if (e instanceof PartyError) return json({ error: e.code }, PARTY_STATUS[e.code]);
  return errorResponse(e);
}

/** GET /api/party/:code — the caller's view. Poll with If-None-Match; unchanged views return 304. */
export async function GET(req: Request, ctx: RouteContext<"/api/party/[code]">) {
  if (!(await rateLimit("party-poll", 240))) return tooMany();
  const code = (await ctx.params).code.toUpperCase();
  if (!CODE_RE.test(code)) return json({ error: "not_found" }, 404);
  try {
    const v = await getPartyView(code, await getPlayerId(false));
    const tag = viewTag(v);
    const headers = { ETag: tag, "Cache-Control": "no-store", "X-Server-Now": String(Date.now()) };
    if (req.headers.get("if-none-match") === tag) return new Response(null, { status: 304, headers });
    return Response.json(v, { headers });
  } catch (e) {
    return partyError(e);
  }
}

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("join"), name: z.string().max(100) }),
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("answer"), round: z.number().int().min(0).max(20), answer: z.string().max(200) }),
  z.object({ action: z.literal("next") }),
  z.object({ action: z.literal("leave") }),
]);

/** POST /api/party/:code { action } — join | start | answer | next | leave. */
export async function POST(req: Request, ctx: RouteContext<"/api/party/[code]">) {
  if (!(await rateLimit("party-act", 60))) return tooMany();
  const code = (await ctx.params).code.toUpperCase();
  if (!CODE_RE.test(code)) return json({ error: "not_found" }, 404);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  let a = parsed.data;
  if (a.action === "join") {
    const n = checkDisplayName(a.name);
    if (!n.ok) return json({ error: n.error }, 422);
    a = { ...a, name: n.name };
  }
  const playerId = a.action === "join" ? (await getPlayerId(true))! : await getPlayerId(false);
  if (!playerId) return json({ error: "not_member" }, 403);
  try {
    const { result, view } = await actOnParty(code, playerId, a);
    return json({ result, view, serverNow: Date.now() });
  } catch (e) {
    return partyError(e);
  }
}
