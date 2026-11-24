"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { DEFAULT_LOOK, entitlements, parseLook, type Appearance, type Need } from "@/lib/game/climb";
import type { AccountStats } from "@/lib/game/profile";

export type Me = {
  email: string;
  displayName: string | null;
  appearance: Appearance;
  /** True until the profile has saved a look (used to carry the guest look over on first sign-in). */
  fresh: boolean;
  stats: AccountStats;
};
export type AccountState =
  | { status: "loading" }
  | { status: "unavailable" } // accounts not configured on this deployment
  | { status: "guest" }
  | { status: "signed-in"; me: Me };

const LOOK_KEY = "ml_look";
let state: AccountState = { status: "loading" };
let inflight: Promise<void> | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function setAccount(next: AccountState) {
  state = next;
  emit();
}

export function refreshAccount(): Promise<void> {
  inflight ??= fetch("/api/me", { cache: "no-store" })
    .then(async (r) => {
      const body = (await r.json()) as { configured: boolean; me: Me | null };
      setAccount(!body.configured ? { status: "unavailable" } : body.me ? { status: "signed-in", me: body.me } : { status: "guest" });
    })
    .catch(() => setAccount({ status: "guest" }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useAccount(): AccountState {
  const s = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
    () => ({ status: "loading" }) as AccountState,
  );
  useEffect(() => {
    if (state.status === "loading" && !inflight) void refreshAccount();
  }, []);
  return s;
}

/* ---------------- guest look on this device ---------------- */
const lookSubs = new Set<() => void>();
let lookCache: { raw: string | null; look: Appearance } | null = null;

function readGuestRaw(): string | null {
  try {
    return localStorage.getItem(LOOK_KEY);
  } catch {
    return null;
  }
}
function guestLook(): Appearance {
  const raw = readGuestRaw();
  if (!lookCache || lookCache.raw !== raw) lookCache = { raw, look: parseLook(raw) };
  return lookCache.look;
}
export function saveGuestLook(l: Appearance) {
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(l));
  } catch {
    /* storage unavailable */
  }
  lookSubs.forEach((f) => f());
}
export function storedGuestLook(): Appearance | null {
  return readGuestRaw() ? guestLook() : null;
}

/** The climber's look and what may be worn: the account profile when signed in, otherwise this device's guest look. */
export function useLook(): { look: Appearance; allowed: Set<Need>; signedIn: boolean; save: (l: Appearance) => Promise<boolean> } {
  const account = useAccount();
  const guest = useSyncExternalStore(
    (f) => {
      lookSubs.add(f);
      return () => lookSubs.delete(f);
    },
    guestLook,
    () => DEFAULT_LOOK,
  );
  const signedIn = account.status === "signed-in";
  const achievements = signedIn ? account.me.stats.achievements : undefined;
  const allowed = useMemo(() => entitlements(signedIn, achievements), [signedIn, achievements]);
  const look = signedIn ? account.me.appearance : guest;
  const save = useCallback(
    async (l: Appearance) => {
      if (state.status !== "signed-in") {
        saveGuestLook(l);
        return true;
      }
      const prev = state.me;
      setAccount({ status: "signed-in", me: { ...prev, appearance: l, fresh: false } }); // optimistic
      const r = await fetch("/api/me", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ appearance: l }) });
      if (!r.ok) {
        setAccount({ status: "signed-in", me: prev });
        return false;
      }
      const body = (await r.json()) as { me: Me };
      setAccount({ status: "signed-in", me: body.me });
      return true;
    },
    [],
  );
  return { look, allowed, signedIn, save };
}
