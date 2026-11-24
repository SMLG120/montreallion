import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOK, LOOK_PARTS, STAIR, SUMMIT_STEPS, bestTier, climbFraction, climbSteps, entitlements, moveFor, parseLook, pointAt, sanitizeLook,
  type ClimbStop,
} from "@/lib/game/climb";

const ok = (score: number, tier: NonNullable<ClimbStop>["tier"]): ClimbStop => ({ status: "correct", tier, score });
const miss: ClimbStop = { status: "incorrect", tier: null, score: 0 };

describe("Mount Royal climb model", () => {
  it("climbs exactly the score, proportionally, and a miss climbs nothing (never falls)", () => {
    expect(climbSteps([ok(30, "tourist"), null, null])).toBe(30);
    expect(climbSteps([ok(30, "tourist"), miss, ok(90, "legend")])).toBe(120);
    expect(climbSteps([ok(30, "tourist"), miss])).toBe(climbSteps([ok(30, "tourist")]));
    expect(climbSteps([{ status: "expired", tier: null, score: 0 }])).toBe(0);
    expect(climbFraction(SUMMIT_STEPS / 2)).toBeCloseTo(0.5);
    expect(climbFraction(70) * 2).toBeCloseTo(climbFraction(140));
    expect(climbFraction(700)).toBe(1);
    expect(climbFraction(-5)).toBe(0);
  });

  it("rarer answers get bigger moves", () => {
    expect(moveFor(ok(15, "tourist"))).toBe("short");
    expect(moveFor(ok(40, "regular"))).toBe("short");
    expect(moveFor(ok(60, "expert"))).toBe("big");
    expect(moveFor(ok(80, "gem"))).toBe("big");
    expect(moveFor(ok(95, "legend"))).toBe("leap");
    expect(moveFor(miss)).toBe("none");
    expect(moveFor(null)).toBe("none");
  });

  it("the staircase only goes up, starts at the base and ends at the lookout", () => {
    for (let i = 1; i < STAIR.length; i++) expect(STAIR[i][1]).toBeLessThan(STAIR[i - 1][1]);
    expect(pointAt(0)).toMatchObject({ x: STAIR[0][0], y: STAIR[0][1] });
    expect(pointAt(1)).toMatchObject({ x: STAIR.at(-1)![0], y: STAIR.at(-1)![1] });
    let prev = Infinity;
    for (let f = 0; f <= 1; f += 0.05) {
      const y = pointAt(f).y;
      expect(y).toBeLessThanOrEqual(prev + 1e-9); // higher score → never lower on the mountain
      prev = y;
    }
  });

  it("reports the best tier reached", () => {
    expect(bestTier([null, miss])).toBeNull();
    expect(bestTier([ok(20, "tourist"), ok(80, "gem"), ok(40, "regular")])).toBe("gem");
  });

  it("parses stored appearance defensively (and reads the phase-E format)", () => {
    expect(parseLook(null)).toEqual(DEFAULT_LOOK);
    expect(parseLook("not json")).toEqual(DEFAULT_LOOK);
    expect(parseLook(JSON.stringify({ skin: 2, jacket: 1, hat: "cap" }))).toMatchObject({ skin: "s2", jacket: "j1", hat: "cap" });
    expect(parseLook(JSON.stringify({ skin: 99, jacket: -1, hat: "<script>" }))).toEqual(DEFAULT_LOOK);
  });
});

describe("cosmetics and unlocks", () => {
  const guest = entitlements(false);
  const account = entitlements(true, []);
  const earned = entitlements(true, ["summit", "legend"]);

  it("guests keep only guest items; accounts add account items; achievements unlock their items", () => {
    const fancy = { hair: "curly", hat: "summit-tuque", accessory: "legend-scarf", pack: "explorer", jacket: "gold" };
    expect(sanitizeLook(fancy, guest)).toEqual(DEFAULT_LOOK);
    expect(sanitizeLook(fancy, account)).toMatchObject({ hair: "curly", hat: DEFAULT_LOOK.hat, accessory: "none", pack: "none", jacket: DEFAULT_LOOK.jacket });
    expect(sanitizeLook(fancy, earned)).toMatchObject({ hair: "curly", hat: "summit-tuque", accessory: "legend-scarf", pack: "none" });
  });

  it("achievements never unlock anything for a guest", () => {
    expect(entitlements(false, ["summit"]).has("summit")).toBe(false);
  });

  it("every part has a free default and unique ids", () => {
    for (const [part, opts] of Object.entries(LOOK_PARTS)) {
      expect(new Set(opts.map((o) => o.id)).size, part).toBe(opts.length);
      expect(opts.find((o) => o.id === DEFAULT_LOOK[part as keyof typeof DEFAULT_LOOK])?.need, part).toBe("guest");
    }
  });
});
