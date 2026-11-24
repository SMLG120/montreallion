import { describe, expect, it } from "vitest";
import { PATH_END, STAIR_NODES, SUMMIT_NODE, TREAD_RISE, TREAD_RUN, progressToPath, sampleStair, terrainHeight, treeSpots, nearestPath, STAIR_WIDTH } from "@/lib/game/stair3d";
import { climbFraction, climbSteps } from "@/lib/game/climb";

describe("3D staircase model", () => {
  it("never descends, and every tread rises exactly one riser over one run", () => {
    for (let i = 1; i < STAIR_NODES.length; i++) {
      const a = STAIR_NODES[i - 1];
      const b = STAIR_NODES[i];
      expect(b.y).toBeGreaterThanOrEqual(a.y);
      if (b.kind === "tread") {
        expect(b.y - a.y).toBeCloseTo(TREAD_RISE, 6);
        if (a.kind === "tread") expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeCloseTo(TREAD_RUN, 6);
      } else expect(b.y).toBe(a.y); // landings and plaza are flat
    }
    expect(STAIR_NODES.filter((n) => n.kind === "tread")).toHaveLength(7 * 24);
  });

  it("samples land exactly on nodes and stay between neighbouring heights (no floating, no sinking)", () => {
    for (let i = 0; i < PATH_END; i++) {
      expect(sampleStair(i).y).toBeCloseTo(STAIR_NODES[i].y, 9);
      for (const t of [0.25, 0.5, 0.75]) {
        const p = sampleStair(i + t);
        expect(p.y).toBeGreaterThanOrEqual(STAIR_NODES[i].y - 1e-9);
        expect(p.y).toBeLessThanOrEqual(STAIR_NODES[i + 1].y + 1e-9);
      }
    }
  });

  it("maps climb progress monotonically, 0 at the foot and the full climb at the top of the stairs", () => {
    expect(progressToPath(0)).toBe(0);
    expect(progressToPath(1)).toBe(SUMMIT_NODE);
    expect(progressToPath(2)).toBe(SUMMIT_NODE);
    const common = progressToPath(climbFraction(climbSteps([{ status: "correct", tier: "tourist", score: 12 }])));
    const rare = progressToPath(climbFraction(climbSteps([{ status: "correct", tier: "legend", score: 100 }])));
    const miss = progressToPath(climbFraction(climbSteps([{ status: "incorrect", tier: null, score: 0 }])));
    expect(miss).toBe(0);
    expect(common).toBeGreaterThan(0);
    expect(rare).toBeGreaterThan(common * 5);
  });

  it("ground sits just under the path (camera and scenery can trust terrainHeight)", () => {
    for (let i = 0; i < STAIR_NODES.length; i += 3) {
      const n = STAIR_NODES[i];
      const g = terrainHeight(n.x, n.z);
      expect(g).toBeLessThan(n.y);
      expect(n.y - g).toBeLessThan(0.5);
    }
  });

  it("places trees deterministically and off the stairs", () => {
    const a = treeSpots(200);
    expect(a).toEqual(treeSpots(200));
    expect(a.length).toBe(200);
    for (const t of a) expect(nearestPath(t.x, t.z).dist).toBeGreaterThan(STAIR_WIDTH / 2 + 1);
  });
});
