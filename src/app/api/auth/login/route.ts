import { z } from "zod";
import { json, rateLimit, tooMany } from "@/lib/server/http";
import { supabaseForRequest } from "@/lib/server/supabase";

const body = z.object({ email: z.string().trim().toLowerCase().email().max(254) });

/** POST /api/auth/login { email } — emails a magic link (sign-up, sign-in and recovery are the same flow). */
export async function POST(req: Request) {
  if (!(await rateLimit("login", 5))) return tooMany();
  const sb = await supabaseForRequest();
  if (!sb) return json({ error: "unavailable" }, 503);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_email" }, 400);
  const { error } = await sb.auth.signInWithOtp({
    email: parsed.data.email,
    options: { emailRedirectTo: `${new URL(req.url).origin}/auth/callback`, shouldCreateUser: true },
  });
  if (error?.status === 429) return tooMany();
  // Same answer whether or not the address already has an account (no account enumeration).
  if (error) return json({ error: "send_failed" }, 502);
  return json({ ok: true });
}
