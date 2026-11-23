import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "public", "map");
type Feature = { geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> };
const index = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8")) as {
  bbox: [number, number, number, number];
  layers: { id: string; file: string; count: number; sources: { url: string; license: string }[] }[];
};
const layer = (id: string) => (JSON.parse(readFileSync(join(DIR, `${id}.geojson`), "utf8")) as { features: Feature[] }).features;
const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const distM = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * 111_320 * Math.cos((45.5 * Math.PI) / 180), (a[1] - b[1]) * 110_540);
const point = (id: string, re: RegExp) => {
  const f = layer(id).find((x) => re.test(norm(String(x.properties.name ?? ""))));
  expect(f, `${id}: ${re}`).toBeTruthy();
  return f!.geometry.coordinates as [number, number];
};
function* coords(c: unknown): Generator<[number, number]> {
  if (Array.isArray(c) && typeof c[0] === "number") yield c as [number, number];
  else if (Array.isArray(c)) for (const x of c) yield* coords(x);
}
function inRing(p: [number, number], ring: [number, number][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

describe("public map layers", () => {
  it("every indexed layer exists, matches its count, and cites a licensed source", () => {
    expect(index.layers.length).toBeGreaterThanOrEqual(14);
    for (const l of index.layers) {
      expect(existsSync(join(DIR, `${l.id}.geojson`)), l.id).toBe(true);
      expect(layer(l.id)).toHaveLength(l.count);
      expect(l.sources.length, l.id).toBeGreaterThan(0);
      for (const s of l.sources) expect(s.license).toMatch(/CC BY|Creative Commons|CC0|ODbL|CC BY-SA/);
    }
  });

  it("all geometry lies in the Greater Montréal box (lines: within the map's pan bounds)", () => {
    const [w, s, e, n] = index.bbox;
    const PAN = [-74.6, 45.0, -72.8, 46.1]; // commuter-train lines legitimately run past the box (e.g. Mont-Saint-Hilaire)
    for (const l of index.layers) {
      const box = ["rail", "roads", "areas", "neighbourhoods"].includes(l.id) ? PAN : [w, s, e, n];
      for (const f of layer(l.id)) for (const [lon, lat] of coords(f.geometry.coordinates)) {
        expect(lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3], `${l.id} ${lon},${lat}`).toBe(true);
      }
    }
  });

  it("carries no question linkage, rarity or eligibility tags", () => {
    for (const l of index.layers) {
      const raw = readFileSync(join(DIR, `${l.id}.geojson`), "utf8");
      expect(raw, l.id).not.toMatch(/"gen-|"est"|"score"|"tier"|"questionId"|"cuisine"|"rarity"/);
    }
  });

  it("has the 19 boroughs and 15 other island municipalities", () => {
    const areas = layer("areas");
    expect(areas.filter((f) => f.properties.kind === "borough")).toHaveLength(19);
    expect(areas.filter((f) => f.properties.kind === "municipality")).toHaveLength(15);
  });

  it("draws the spec's autoroutes (A-10, 13, 15, 20, 25, 40, 520) and numbered routes", () => {
    const refs = new Set(layer("roads").flatMap((f) => f.properties.refs as string[]));
    for (const r of ["A-10", "A-13", "A-15", "A-20", "A-25", "A-40", "A-520", "R-138", "R-117"]) expect(refs.has(r), r).toBe(true);
  });

  it("places well-known landmarks where they are (marker accuracy)", () => {
    // Reference points: published coordinates of each landmark (station entrance / building / park centre).
    const cases: [string, RegExp, [number, number], number][] = [
      ["stations", /^berri/, [-73.5612, 45.5154], 250],
      ["stations", /^jean-talon$/, [-73.614, 45.5389], 250],
      ["heritage", /^habitat 67$/, [-73.5434, 45.4996], 400],
      ["parks", /^parc la fontaine$/, [-73.57, 45.527], 600],
      ["museums", /beaux-arts de montreal|museum of fine arts/, [-73.5794, 45.4985], 400],
      ["bridges", /jacques-cartier/, [-73.5419, 45.5222], 2500],
      ["interchanges", /turcot/, [-73.586, 45.474], 1500],
    ];
    for (const [id, re, ref, tol] of cases) expect(distM(point(id, re), ref), `${id} ${re}`).toBeLessThan(tol);
  });

  it("a station falls inside its borough polygon", () => {
    const vm = layer("areas").find((f) => f.properties.name === "Ville-Marie")!;
    const p = point("stations", /^berri/);
    const polys = (vm.geometry.type === "Polygon" ? [vm.geometry.coordinates] : vm.geometry.coordinates) as [number, number][][][];
    expect(polys.some((poly) => inRing(p, poly[0]))).toBe(true);
  });

  it("keeps each layer small enough to load on mobile", () => {
    for (const l of index.layers) expect(readFileSync(join(DIR, `${l.id}.geojson`)).length, l.id).toBeLessThan(2_500_000);
  });
});
