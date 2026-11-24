import { z } from "zod";
import { entitlements, sanitizeLook } from "@/lib/game/climb";
import { defaultStore } from "@/lib/game/store";
import { errorResponse, getPlayerId, json, rateLimit, tooMany } from "@/lib/server/http";
import { checkDisplayName, currentUser, linkDevice, loadMe, supabaseForRequest } from "@/lib/server/supabase";

/** GET /api/me — the signed-in player's own profile and progress (email only ever goes to its owner). */
export async function GET() {
  if (!(await rateLimit("me", 60))) return tooMany();
  const sb = await supabaseForRequest();
  if (!sb) return json({ configured: false, me: null });
  try {
    const user = await currentUser(sb);
    if (!user) return json({ configured: true, me: null });
    const me = await loadMe(sb, user);
    const pid = await getPlayerId(false);
    if (pid) await linkDevice(user.id, pid, me.displayName); // a device that played as a guest while signed in
    return json({ configured: true, me });
  } catch (e) {
    return errorResponse(e);
  }
}

const body = z.object({
  displayName: z.string().max(100).nullable().optional(),
  appearance: z.record(z.string(), z.string().max(32)).optional(),
});

/** PUT /api/me { displayName?, appearance? } — owner-only update; locked cosmetics are refused. */
export async function PUT(req: Request) {
  if (!(await rateLimit("me-put", 20))) return tooMany();
  const sb = await supabaseForRequest();
  if (!sb) return json({ error: "unavailable" }, 503);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  try {
    const user = await currentUser(sb);
    if (!user) return json({ error: "unauthorized" }, 401);
    const current = await loadMe(sb, user);
    const patch: { display_name?: string | null; appearance?: Record<string, string> } = {};

    if (parsed.data.displayName !== undefined) {
      const raw = parsed.data.displayName;
      if (raw === null || raw.trim() === "") patch.display_name = null;
      else {
        const check = checkDisplayName(raw);
        if (!check.ok) return json({ error: check.error }, 422);
        patch.display_name = check.name;
      }
    }
    if (parsed.data.appearance) {
      const allowed = entitlements(true, current.stats.achievements);
      const clean = sanitizeLook(parsed.data.appearance, allowed);
      const asked = parsed.data.appearance;
      if (Object.keys(clean).some((k) => asked[k] !== undefined && asked[k] !== clean[k as keyof typeof clean])) return json({ error: "locked" }, 422);
      patch.appearance = clean;
    }
    if (Object.keys(patch).length) {
      // Runs as the user: RLS + column grants allow only their own name and look.
      const { error } = await sb.from("profiles").update(patch).eq("id", user.id);
      if (error) return json({ error: "save_failed" }, 500);
    }
    if (patch.display_name !== undefined) {
      const store = await defaultStore();
      for (const pid of await store.accountPlayers(user.id)) await store.setDisplayName(pid, patch.display_name);
    }
    return json({ me: await loadMe(sb, user) });
  } catch (e) {
    return errorResponse(e);
  }
}
