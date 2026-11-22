"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { DICTS, type Dict } from "@/lib/i18n/dict";
import type { Locale } from "@/lib/game/types";

type Ctx = {
  locale: Locale;
  t: Dict;
  setLocale: (l: Locale) => void;
  sound: boolean;
  setSound: (on: boolean) => void;
};

const AppCtx = createContext<Ctx | null>(null);

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage unavailable */
  }
}

export function AppProviders({ initialLocale, children }: { initialLocale: Locale; children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [sound, setSoundState] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate a client-only preference
    setSoundState(readPref("ml_sound") === "1");
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    document.documentElement.lang = l === "fr" ? "fr-CA" : "en-CA";
    document.cookie = `ml_locale=${l}; path=/; max-age=31536000; samesite=lax`;
  }, []);

  const setSound = useCallback((on: boolean) => {
    setSoundState(on);
    writePref("ml_sound", on ? "1" : "0");
  }, []);

  const value = useMemo(() => ({ locale, t: DICTS[locale], setLocale, sound, setSound }), [locale, setLocale, sound, setSound]);
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside AppProviders");
  return c;
}
