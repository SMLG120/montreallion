import { describe, expect, it } from "vitest";
import { accountStats, streaks, type RideRow } from "@/lib/game/profile";

const ride = (i: number, over: Partial<RideRow> = {}): RideRow => ({
  id: `r${i}`, mode: "unlimited", dateKey: null, finishedAt: 1_700_000_000_000 + i * 1000, total: 100, tiers: ["tourist", null, null, null, null, null, null], ...over,
});
const daily = (i: number, dateKey: string, total = 120) => ride(i, { mode: "daily", dateKey, total });

describe("daily streaks", () => {
  it("counts consecutive days ending today or yesterday", () => {
    expect(streaks(["2026-11-21", "2026-11-22", "2026-11-23"], "2026-11-23")).toEqual({ streak: 3, best: 3 });
    expect(streaks(["2026-11-21", "2026-11-22"], "2026-11-23")).toEqual({ streak: 2, best: 2 });
    expect(streaks(["2026-11-20", "2026-11-21"], "2026-11-23")).toEqual({ streak: 0, best: 2 });
    expect(streaks(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-22", "2026-11-23"], "2026-11-23")).toEqual({ streak: 2, best: 4 });
    expect(streaks([], "2026-11-23")).toEqual({ streak: 0, best: 0 });
  });
  it("handles month boundaries and duplicates", () => {
    expect(streaks(["2026-10-31", "2026-11-01", "2026-11-01"], "2026-11-01")).toEqual({ streak: 2, best: 2 });
  });
});

describe("account stats", () => {
  it("computes personal bests, lifetime climb, summits and achievements", () => {
    const rides = [
      daily(1, "2026-11-21", 200),
      daily(2, "2026-11-22", 380),
      daily(3, "2026-11-23", 150),
      ride(4, { total: 410, tiers: ["legend", "gem", "expert", "regular", "tourist", "gem", "expert"] }),
      ride(5, { total: 90 }),
    ];
    const s = accountStats(rides, "2026-11-23");
    expect(s).toMatchObject({ rides: 5, bestDaily: 380, bestUnlimited: 410, streak: 3, bestStreak: 3, totalSteps: 1230, summits: 2, legends: 1 });
    expect(s.achievements).toEqual(["first-ride", "summit", "legend", "perfect", "streak-3"]);
    expect(s.recent[0].id).toBe("r5"); // newest first
  });
  it("is empty for a new account", () => {
    expect(accountStats([], "2026-11-23")).toMatchObject({ rides: 0, bestDaily: null, bestUnlimited: null, streak: 0, achievements: [] });
  });
  it("ten rides unlock rides-10", () => {
    expect(accountStats(Array.from({ length: 10 }, (_, i) => ride(i)), "2026-11-23").achievements).toContain("rides-10");
  });
});
