import type { Tier } from "./types";

/**
 * Mount Royal climb (phase E): a GAMIFIED progress model, not real altitude.
 * Every correct answer climbs exactly its score in "steps"; a miss climbs 0 (and never falls back).
 * The lookout sits at SUMMIT_STEPS: 7 stops averaging 50 points reach it; beyond that the climber stays there.
 */
export const SUMMIT_STEPS = 350;

export type ClimbStop = { status: "correct" | "incorrect" | "expired"; tier: Tier | null; score: number } | null;
export type Move = "none" | "short" | "big" | "leap";

/** Animation style for one answer: rarer answers move more dramatically. */
export function moveFor(stop: ClimbStop): Move {
  if (!stop || stop.status !== "correct" || stop.score <= 0) return "none";
  if (stop.tier === "legend") return "leap";
  if (stop.tier === "gem" || stop.tier === "expert") return "big";
  return "short";
}

export function stepsFor(stop: ClimbStop): number {
  return stop && stop.status === "correct" ? Math.max(0, stop.score) : 0;
}

export function climbSteps(stops: ClimbStop[]): number {
  return stops.reduce((t, s) => t + stepsFor(s), 0);
}

/** 0..1 along the staircase; proportional to steps until the lookout. */
export function climbFraction(steps: number): number {
  return Math.min(1, Math.max(0, steps / SUMMIT_STEPS));
}

/** Staircase in a 360 × 1000 world (y grows downward): switchbacks from the base (bottom) to the lookout (top). */
export const WORLD = { w: 360, h: 1000 };
export const STAIR: [number, number][] = [
  [56, 940],
  [300, 860],
  [80, 760],
  [290, 650],
  [96, 545],
  [276, 440],
  [118, 340],
  [250, 245],
  [176, 150],
];

const SEGS = STAIR.slice(1).map((p, i) => Math.hypot(p[0] - STAIR[i][0], p[1] - STAIR[i][1]));
const LENGTH = SEGS.reduce((a, b) => a + b, 0);

/** Point at fraction f of the staircase's length, and which way the climber faces there. */
export function pointAt(f: number): { x: number; y: number; facing: 1 | -1 } {
  if (f >= 1) {
    const [x, y] = STAIR[STAIR.length - 1];
    return { x, y, facing: 1 };
  }
  let d = Math.max(0, f) * LENGTH;
  for (let i = 0; i < SEGS.length; i++) {
    const [x0, y0] = STAIR[i];
    const [x1, y1] = STAIR[i + 1];
    if (d <= SEGS[i] || i === SEGS.length - 1) {
      const t = SEGS[i] ? Math.min(1, d / SEGS[i]) : 0;
      return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, facing: x1 >= x0 ? 1 : -1 };
    }
    d -= SEGS[i];
  }
  const [x, y] = STAIR[STAIR.length - 1];
  return { x, y, facing: 1 };
}

/** Highest tier reached so far (for the "current rarity tier" badge). */
const ORDER: Tier[] = ["tourist", "regular", "expert", "gem", "legend"];
export function bestTier(stops: ClimbStop[]): Tier | null {
  let best = -1;
  for (const s of stops) if (s?.status === "correct" && s.tier) best = Math.max(best, ORDER.indexOf(s.tier));
  return best < 0 ? null : ORDER[best];
}

// ---------------------------------------------------------------- appearance
// Modular, original character layers. Every option says who may wear it: anyone ("guest"), signed-in players
// ("account"), or players who earned an achievement (unlockable cosmetics). The server re-checks on save and read.

export type Need = "guest" | "account" | "summit" | "legend" | "perfect" | "streak-3" | "rides-10" | "streak-7";
export type Option = { id: string; color?: string; need: Need };

export const SKIN_OPTS: Option[] = ["#f6d3b3", "#e0ac83", "#b97a56", "#7a4a2f", "#4b2c1c"].map((c, i) => ({ id: `s${i}`, color: c, need: "guest" }));
export const HAIR_OPTS: Option[] = [
  { id: "short", need: "guest" }, { id: "long", need: "account" }, { id: "curly", need: "account" },
  { id: "bun", need: "account" }, { id: "buzz", need: "account" },
];
export const HAIR_COLOR_OPTS: Option[] = ["#2b1d14", "#5a3a22", "#a8743f", "#e2c27a", "#c8452c"].map((c, i) => ({ id: `h${i}`, color: c, need: i === 0 ? "guest" : "account" }));
export const JACKET_OPTS: Option[] = [
  ...["#e8463a", "#1f8a5b", "#2f6fdc", "#f2a516", "#7b4fd6", "#1d2433"].map((c, i): Option => ({ id: `j${i}`, color: c, need: i < 3 ? "guest" : "account" })),
  { id: "gold", color: "#d4a62a", need: "perfect" },
];
export const PANTS_OPTS: Option[] = ["#2a2f45", "#3d5a80", "#5b4636", "#1a1a1a"].map((c, i) => ({ id: `p${i}`, color: c, need: i === 0 ? "guest" : "account" }));
export const HAT_OPTS: Option[] = [
  { id: "tuque", need: "guest" }, { id: "cap", need: "guest" }, { id: "none", need: "guest" },
  { id: "beret", need: "account" }, { id: "helmet", need: "account" }, { id: "summit-tuque", need: "summit" },
];
export const PACK_OPTS: Option[] = [
  { id: "none", need: "guest" }, { id: "daypack", need: "account" }, { id: "ski", need: "account" }, { id: "explorer", need: "rides-10" },
];
export const ACCESSORY_OPTS: Option[] = [
  { id: "none", need: "guest" }, { id: "scarf", need: "account" }, { id: "glasses", need: "account" },
  { id: "headphones", need: "account" }, { id: "legend-scarf", need: "legend" }, { id: "medal", need: "streak-3" }, { id: "lantern", need: "streak-7" },
];

export const LOOK_PARTS = {
  skin: SKIN_OPTS, hair: HAIR_OPTS, hairColor: HAIR_COLOR_OPTS, jacket: JACKET_OPTS,
  pants: PANTS_OPTS, hat: HAT_OPTS, pack: PACK_OPTS, accessory: ACCESSORY_OPTS,
} as const;
export type Part = keyof typeof LOOK_PARTS;
export type Appearance = Record<Part, string>;
export const DEFAULT_LOOK: Appearance = { skin: "s1", hair: "short", hairColor: "h0", jacket: "j0", pants: "p0", hat: "tuque", pack: "none", accessory: "none" };

/** What a player may wear: guests get "guest" items; accounts add "account" items plus their earned unlocks. */
export function entitlements(signedIn: boolean, achievements: readonly string[] = []): Set<Need> {
  const s = new Set<Need>(["guest"]);
  if (signedIn) {
    s.add("account");
    for (const a of achievements) s.add(a as Need);
  }
  return s;
}

export const option = (part: Part, id: string) => LOOK_PARTS[part].find((o) => o.id === id);

/** Keeps only valid, permitted items; anything unknown or locked falls back to the default for that part. */
export function sanitizeLook(v: unknown, allowed: Set<Need>): Appearance {
  const src = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const out = { ...DEFAULT_LOOK };
  for (const part of Object.keys(LOOK_PARTS) as Part[]) {
    const o = typeof src[part] === "string" ? option(part, src[part] as string) : undefined;
    if (o && allowed.has(o.need)) out[part] = o.id;
  }
  return out;
}

/** Parse untrusted stored JSON into a valid guest appearance. Also reads the phase-E format ({skin, jacket} indexes). */
export function parseLook(raw: string | null, allowed: Set<Need> = entitlements(false)): Appearance {
  try {
    const v = JSON.parse(raw ?? "null") as Record<string, unknown> | null;
    if (!v || typeof v !== "object") return DEFAULT_LOOK;
    const legacy = { ...v };
    if (Number.isInteger(v.skin)) legacy.skin = `s${v.skin}`;
    if (Number.isInteger(v.jacket)) legacy.jacket = `j${v.jacket}`;
    return sanitizeLook(legacy, allowed);
  } catch {
    return DEFAULT_LOOK;
  }
}
