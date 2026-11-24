import { z } from "zod";
import { entitlements, sanitizeLook } from "@/lib/game/climb";
import { defaultStore, type ProfilePatch } from "@/lib/game/store";
import { errorResponse, getPlayerId, json, rateLimit, tooMany } from "@/lib/server/http";
import { authBackend, checkDisplayName, linkDevice, loadMe } from "@/lib/server/auth";

/** GET /api/me — the signed-in player's own profile and progress (email only ever goes to its owner). */
export async function GET() {
  if (!(await rateLimit("me", 60))) return tooMany();
  const auth = authBackend();
  if (!auth) return json({ configured: false, me: null });
  try {
    const user = await auth.currentUser();
    if (!user) return json({ configured: true, me: null });
    const me = await loadMe(user);
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
  const auth = authBackend();
  if (!auth) return json({ error: "unavailable" }, 503);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  try {
    const user = await auth.currentUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const current = await loadMe(user);
    const patch: ProfilePatch = {};

    if (parsed.data.displayName !== undefined) {
      const raw = parsed.data.displayName;
      if (raw === null || raw.trim() === "") patch.displayName = null;
      else {
        const check = checkDisplayName(raw);
        if (!check.ok) return json({ error: check.error }, 422);
        patch.displayName = check.name;
      }
    }
    if (parsed.data.appearance) {
      const allowed = entitlements(true, current.stats.achievements);
      const clean = sanitizeLook(parsed.data.appearance, allowed);
      const asked = parsed.data.appearance;
      if (Object.keys(clean).some((k) => asked[k] !== undefined && asked[k] !== clean[k as keyof typeof clean])) return json({ error: "locked" }, 422);
      patch.appearance = clean;
    }
    const store = await defaultStore();
    // Postgres runs this as the restricted account role: RLS + column grants allow only this user's name and look.
    if (Object.keys(patch).length) await store.saveProfile(user.id, patch);
    if (patch.displayName !== undefined) {
      for (const pid of await store.accountPlayers(user.id)) await store.setDisplayName(pid, patch.displayName);
    }
    return json({ me: await loadMe(user) });
  } catch (e) {
    return errorResponse(e);
  }
}
