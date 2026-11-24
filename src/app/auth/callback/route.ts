import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getPlayerId } from "@/lib/server/http";
import { currentUser, linkDevice, supabaseForRequest } from "@/lib/server/supabase";

const TYPES = new Set<EmailOtpType>(["magiclink", "signup", "email", "recovery", "invite", "email_change"]);

/** GET /auth/callback — finishes a magic-link sign-in, then links this device's guest rides to the account. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => NextResponse.redirect(new URL(`/account?${q}`, url.origin), 303);
  const sb = await supabaseForRequest();
  if (!sb) return back("error=unavailable");
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const { error } = code
    ? await sb.auth.exchangeCodeForSession(code)
    : tokenHash && type && TYPES.has(type)
      ? await sb.auth.verifyOtp({ token_hash: tokenHash, type })
      : { error: new Error("missing code") };
  if (error) return back("error=link");
  const user = await currentUser(sb);
  if (!user) return back("error=link");
  const { data: profile } = await sb.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
  await linkDevice(user.id, (await getPlayerId(true))!, profile?.display_name ?? null);
  return back("welcome=1");
}
