import { json } from "@/lib/server/http";
import { authBackend } from "@/lib/server/auth";

/** POST /api/auth/logout — ends the session on this device (guest play continues). */
export async function POST() {
  await authBackend()?.signOut();
  return json({ ok: true });
}
