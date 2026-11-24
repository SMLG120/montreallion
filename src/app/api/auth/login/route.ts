import { z } from "zod";
import { json, rateLimit, tooMany } from "@/lib/server/http";
import { authBackend } from "@/lib/server/auth";

const body = z.object({ email: z.string().trim().toLowerCase().email().max(254) });

/** POST /api/auth/login { email } — emails a 6-digit sign-in code (sign-up, sign-in and recovery are one flow). */
export async function POST(req: Request) {
  if (!(await rateLimit("login", 5))) return tooMany();
  const auth = authBackend();
  if (!auth) return json({ error: "unavailable" }, 503);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_email" }, 400);
  const r = await auth.sendCode(parsed.data.email);
  if (!r.ok && r.reason === "rate") return tooMany();
  // Same answer whether or not the address already has an account (no account enumeration).
  if (!r.ok) return json({ error: "send_failed" }, 502);
  return json({ ok: true });
}
