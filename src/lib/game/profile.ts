import type { Tier } from "./types";
import { SUMMIT_STEPS } from "./climb";

/** One finished ride, as read from the game database for an account's linked players. */
export type RideRow = {
  id: string;
  mode: "daily" | "unlimited";
  dateKey: string | null;
  finishedAt: number;
  total: number;
  tiers: (Tier | null)[];
};

export const ACHIEVEMENTS = ["first-ride", "summit", "legend", "perfect", "streak-3", "rides-10", "streak-7"] as const;
export type Achievement = (typeof ACHIEVEMENTS)[number];

export type AccountStats = {
  rides: number;
  bestDaily: number | null;
  bestUnlimited: number | null;
  streak: number;
  bestStreak: number;
  /** Lifetime climb: every ride's score in steps (gamified, like the per-ride climb). */
  totalSteps: number;
  summits: number;
  legends: number;
  achievements: Achievement[];
  recent: { id: string; mode: RideRow["mode"]; dateKey: string | null; finishedAt: number; total: number }[];
};

const DAY = 86_400_000;
const dayNum = (k: string) => Math.round(Date.parse(`${k}T00:00:00Z`) / DAY);

/** Daily streaks from the distinct date keys of finished dailies. The current streak counts if it ends today or yesterday. */
export function streaks(dateKeys: string[], today: string): { streak: number; best: number } {
  const days = [...new Set(dateKeys)].map(dayNum).sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  const last = days.at(-1);
  const t = dayNum(today);
  const streak = last !== undefined && (last === t || last === t - 1) ? run : 0;
  return { streak, best };
}

export function accountStats(rides: RideRow[], today: string): AccountStats {
  const done = [...rides].sort((a, b) => b.finishedAt - a.finishedAt);
  const best = (mode: RideRow["mode"]) => {
    const xs = done.filter((r) => r.mode === mode).map((r) => r.total);
    return xs.length ? Math.max(...xs) : null;
  };
  const { streak, best: bestStreak } = streaks(done.filter((r) => r.mode === "daily" && r.dateKey).map((r) => r.dateKey!), today);
  const summits = done.filter((r) => r.total >= SUMMIT_STEPS).length;
  const legends = done.reduce((n, r) => n + r.tiers.filter((t) => t === "legend").length, 0);
  const perfect = done.some((r) => r.tiers.length >= 7 && r.tiers.every((t) => t !== null));
  const has: Record<Achievement, boolean> = {
    "first-ride": done.length >= 1,
    summit: summits >= 1,
    legend: legends >= 1,
    perfect,
    "streak-3": bestStreak >= 3,
    "rides-10": done.length >= 10,
    "streak-7": bestStreak >= 7,
  };
  return {
    rides: done.length,
    bestDaily: best("daily"),
    bestUnlimited: best("unlimited"),
    streak,
    bestStreak,
    totalSteps: done.reduce((n, r) => n + r.total, 0),
    summits,
    legends,
    achievements: ACHIEVEMENTS.filter((a) => has[a]),
    recent: done.slice(0, 10).map(({ id, mode, dateKey, finishedAt, total }) => ({ id, mode, dateKey, finishedAt, total })),
  };
}
