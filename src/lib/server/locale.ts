import "server-only";
import { cookies, headers } from "next/headers";
import { DICTS } from "@/lib/i18n/dict";
import type { Locale } from "@/lib/game/types";

export const LOCALE_COOKIE = "ml_locale";

/** Explicit choice (cookie) first, then the browser's Accept-Language (first of fr/en by q-weight), else English. */
export function pickLocale(cookie: string | undefined, acceptLanguage: string | null): Locale {
  if (cookie === "fr" || cookie === "en") return cookie;
  const langs = (acceptLanguage ?? "")
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().toLowerCase().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      return { lang: tag.split("-")[0], q: q ? Number(q.split("=")[1]) || 0 : 1 };
    })
    .filter((x) => x.lang === "fr" || x.lang === "en")
    .sort((a, b) => b.q - a.q);
  return langs[0]?.lang === "fr" ? "fr" : "en";
}

export async function getLocale(): Promise<Locale> {
  const [jar, h] = await Promise.all([cookies(), headers()]);
  return pickLocale(jar.get(LOCALE_COOKIE)?.value, h.get("accept-language"));
}

export async function getDict() {
  return DICTS[await getLocale()];
}
