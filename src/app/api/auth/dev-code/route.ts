import { authConfig, devAuth } from "@/lib/server/auth";
import { json } from "@/lib/server/http";

/**
 * GET /api/auth/dev-code?email= — end-to-end tests only: the last code the in-memory test backend "emailed".
 * Exists only when AUTH_DEV_BACKEND=1 off Vercel (authConfig refuses it there); otherwise a plain 404.
 */
export async function GET(req: Request) {
  if (authConfig()?.kind !== "dev") return new Response("Not found", { status: 404 });
  const email = new URL(req.url).searchParams.get("email")?.trim().toLowerCase() ?? "";
  const code = devAuth().lastCode(email);
  return code ? json({ code }) : json({ error: "none" }, 404);
}
