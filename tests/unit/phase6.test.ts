import { describe, expect, it } from "vitest";
import { seedBank } from "@/lib/game/bank";
import { questionContentHash } from "@/lib/game/content-hash";
import { createEngine, GameError } from "@/lib/game/engine";
import { createMemoryStore } from "@/lib/game/store";
import { DICTS } from "@/lib/i18n/dict";
import { adminEnabled, makeAdminSession, readAdminSession, tokenMatches } from "@/lib/server/admin-auth";
import { pickLocale } from "@/lib/server/locale";

const TOKEN = "t0ken-for-tests-0123456789abcdef";

describe("admin session cookie", () => {
  const now = Date.parse("2026-11-21T15:00:00Z");
  it("round-trips the reviewer name and rejects tampering, expiry and token rotation", () => {
    const v = makeAdminSession("Émilie R.", now, TOKEN);
    expect(readAdminSession(v, now + 1000, TOKEN)).toEqual({ reviewer: "Émilie R." });
    const [exp, who, sig] = v.split(".");
    expect(readAdminSession(`${Number(exp) + 99999}.${who}.${sig}`, now, TOKEN)).toBeNull();
    expect(readAdminSession(`${exp}.${Buffer.from("Mallory").toString("base64url")}.${sig}`, now, TOKEN)).toBeNull();
    expect(readAdminSession(v, now + 13 * 3600_000, TOKEN)).toBeNull();
    expect(readAdminSession(v, now, `${TOKEN}-rotated`)).toBeNull();
    expect(readAdminSession("garbage", now, TOKEN)).toBeNull();
    expect(readAdminSession(undefined, now, TOKEN)).toBeNull();
  });

  it("is disabled without a long token, and compares tokens exactly", () => {
    expect(adminEnabled(undefined)).toBe(false);
    expect(adminEnabled("short")).toBe(false);
    expect(adminEnabled(TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches("short", "short")).toBe(false);
    expect(readAdminSession(makeAdminSession("a", Date.now(), "short"), Date.now(), "short")).toBeNull();
  });
});

describe("locale detection", () => {
  it.each([
    ["fr", null, "fr"],
    ["en", "fr-CA,fr;q=0.9", "en"],
    [undefined, "fr-CA,fr;q=0.9,en;q=0.8", "fr"],
    [undefined, "en-US,en;q=0.9,fr;q=0.8", "en"],
    [undefined, "de-DE,fr;q=0.7,en;q=0.5", "fr"],
    [undefined, "en;q=0.4,fr;q=0.6", "fr"],
    [undefined, "es-ES", "en"],
    [undefined, null, "en"],
    ["xx", "fr", "fr"],
  ] as const)("cookie=%s accept=%s → %s", (cookie, accept, want) => {
    expect(pickLocale(cookie, accept)).toBe(want);
  });
});

describe("dictionaries", () => {
  type Tree = { [k: string]: unknown };
  const SAME_OK = new Set(["Admin", "Questions", "Sources", "Montréallion", "Total", "Terminus", "Notes", "Note", "Culture", "Autoroute", "Square", "Restaurant", "Café", "Tuque"]);
  // Functions whose output is legitimately identical in both languages for the probe arguments ("2 ha").
  const SAME_FN_OK = new Set(["t.map.hectares"]);

  function walk(en: unknown, fr: unknown, path: string, out: string[]) {
    if (typeof en === "string") {
      if (typeof fr !== "string") return out.push(`${path}: type`);
      if (en && !fr) out.push(`${path}: empty FR`);
      if (en === fr && en.length > 3 && !SAME_OK.has(en) && !/^[A-Z0-9 /:.·-]+$/.test(en)) out.push(`${path}: untranslated "${en}"`);
    } else if (typeof en === "function") {
      if (typeof fr !== "function") return out.push(`${path}: type`);
      const args = Array.from({ length: en.length }, (_, i) => (i === 0 ? 2 : 41));
      const a = (en as (...x: unknown[]) => unknown)(...args);
      const b = (fr as (...x: unknown[]) => unknown)(...args);
      if (typeof b !== "string" || !b || (a === b && !SAME_FN_OK.has(path))) out.push(`${path}(): bad FR output`);
    } else if (Array.isArray(en)) {
      if (!Array.isArray(fr) || fr.length !== en.length) return out.push(`${path}: array length`);
      en.forEach((x, i) => walk(x, fr[i], `${path}[${i}]`, out));
    } else if (en && typeof en === "object") {
      for (const k of Object.keys(en as Tree)) walk((en as Tree)[k], (fr as Tree)?.[k], `${path}.${k}`, out);
      for (const k of Object.keys((fr as Tree) ?? {})) if (!(k in (en as Tree))) out.push(`${path}.${k}: extra FR key`);
    }
    return out;
  }

  it("FR covers every EN string and function, translated", () => {
    expect(walk(DICTS.en, DICTS.fr, "t", [])).toEqual([]);
  });

  it("every bundled question is bilingual", () => {
    for (const q of seedBank().questions) {
      expect(q.prompt.fr && q.prompt.fr !== q.prompt.en, q.id).toBeTruthy();
      expect(q.eligibility.fr, q.id).toBeTruthy();
    }
  });
});

describe("Unlimited", () => {
  const P = "11111111-1111-4111-8111-111111111111";
  const make = () => {
    let r = 0.1;
    return createEngine({ store: createMemoryStore(), now: () => Date.parse("2026-11-21T15:00:00Z"), random: () => (r = (r * 9301 + 0.49297) % 1), bank: async () => seedBank() });
  };

  it("filters by category and refuses categories that are too small", async () => {
    const engine = make();
    const s = await engine.start(P, "unlimited", { category: "transit" });
    const transit = seedBank().questions.filter((q) => q.category === "transit");
    expect(s.questionIds.length).toBe(Math.min(7, transit.length));
    expect(s.questionIds.every((id) => seedBank().get(id).category === "transit")).toBe(true);
    const tiny = (["food", "history", "festivals", "sports", "universities", "winter", "slang"] as const).find(
      (c) => seedBank().questions.filter((q) => q.category === c).length < 3,
    );
    if (tiny) await expect(engine.start(P, "unlimited", { category: tiny })).rejects.toThrow(GameError);
  });

  it("avoids repeating questions from recent sessions while fresh ones exist", async () => {
    const engine = make();
    const a = await engine.start(P, "unlimited");
    const b = await engine.start(P, "unlimited");
    const pool = seedBank().questions.length;
    const overlap = b.questionIds.filter((id) => a.questionIds.includes(id)).length;
    expect(overlap).toBe(Math.max(0, 14 - pool));
    expect(new Set(b.questionIds).size).toBe(b.questionIds.length);
  });
});

describe("content hash", () => {
  it("is stable and changes when answers change", () => {
    const q = seedBank().get("stm-orange-line-station");
    expect(questionContentHash(q)).toBe(questionContentHash(structuredClone(q)));
    const changed = structuredClone(q);
    changed.answers[0].est += 1;
    expect(questionContentHash(changed)).not.toBe(questionContentHash(q));
  });
});
