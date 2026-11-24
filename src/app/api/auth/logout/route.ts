import { json } from "@/lib/server/http";
import { supabaseForRequest } from "@/lib/server/supabase";

/** POST /api/auth/logout — ends the session on this device (guest play continues). */
export async function POST() {
  const sb = await supabaseForRequest();
  if (sb) await sb.auth.signOut({ scope: "local" });
  return json({ ok: true });
}
