import { z } from "zod";
import { errorResponse, getPlayerId, json, rateLimit, tooMany } from "@/lib/server/http";
import { authBackend, linkDevice, loadMe } from "@/lib/server/auth";

const body = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  code: z.string().trim().regex(/^\d{6}$/),
});

/** POST /api/auth/verify { email, code } — signs in with the emailed code, then links this device's guest rides. */
export async function POST(req: Request) {
  if (!(await rateLimit("verify", 10))) return tooMany();
  const auth = authBackend();
  if (!auth) return json({ error: "unavailable" }, 503);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_code" }, 400);
  try {
    const r = await auth.verifyCode(parsed.data.email, parsed.data.code);
    if (!r.ok) return r.reason === "rate" ? tooMany() : json({ error: r.reason === "invalid" ? "bad_code" : "failed" }, r.reason === "invalid" ? 400 : 502);
    const before = await loadMe(r.user);
    await linkDevice(r.user.id, (await getPlayerId(true))!, before.displayName);
    return json({ me: await loadMe(r.user) });
  } catch (e) {
    return errorResponse(e);
  }
}
