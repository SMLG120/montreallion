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

// ---------------------------------------------------------------- appearance (persisted on this device; accounts arrive in phase F)

export const SKINS = ["#f6d3b3", "#e0ac83", "#b97a56", "#7a4a2f", "#4b2c1c"] as const;
export const JACKETS = ["#e8463a", "#1f8a5b", "#2f6fdc", "#f2a516", "#7b4fd6", "#1d2433"] as const;
export const HATS = ["tuque", "cap", "none"] as const;
export type Appearance = { skin: number; jacket: number; hat: (typeof HATS)[number] };
export const DEFAULT_LOOK: Appearance = { skin: 1, jacket: 0, hat: "tuque" };

/** Parse untrusted stored JSON into a valid appearance (bad or missing fields fall back to defaults). */
export function parseLook(raw: string | null): Appearance {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<Appearance> | null;
    if (!v || typeof v !== "object") return DEFAULT_LOOK;
    const idx = (n: unknown, len: number, d: number) => (Number.isInteger(n) && (n as number) >= 0 && (n as number) < len ? (n as number) : d);
    return {
      skin: idx(v.skin, SKINS.length, DEFAULT_LOOK.skin),
      jacket: idx(v.jacket, JACKETS.length, DEFAULT_LOOK.jacket),
      hat: HATS.includes(v.hat as Appearance["hat"]) ? (v.hat as Appearance["hat"]) : DEFAULT_LOOK.hat,
    };
  } catch {
    return DEFAULT_LOOK;
  }
}
