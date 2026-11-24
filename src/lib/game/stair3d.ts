/**
 * 3D Mount Royal staircase (pure, no three.js): the geometry the climber walks on, shared by the scene and tests.
 *
 * Units are metres. The staircase climbs toward −z in switchback flights angled left/right of the slope, with
 * flat landings between flights and a short walk onto the lookout plaza at the top. It is a stylized evocation
 * of the stairs up to the Kondiaronk lookout, not a survey of them; progress along it is the gamified climb
 * fraction from climb.ts (score / SUMMIT_STEPS), never a claim about real elevation.
 */

export type Vec3 = { x: number; y: number; z: number };
/** A walkable waypoint: the centre of a tread top (feet rest exactly at `y`) or a flat landing/plaza point. */
export type StairNode = Vec3 & { kind: "tread" | "landing" | "plaza"; flight: number };
export type Flight = { start: Vec3; dir: { x: number; z: number }; treads: number };

export const TREAD_RISE = 0.17;
export const TREAD_RUN = 0.34;
export const STAIR_WIDTH = 1.7;
export const FLIGHTS = 7;
export const TREADS_PER_FLIGHT = 24;
/** Flights deviate this far (radians) from straight up the slope, alternating sides. */
const FLIGHT_ANGLE = 0.62;
const LANDING_STEP = 0.55;

function flightDir(k: number) {
  const side = k % 2 === 0 ? 1 : -1;
  return { x: side * Math.sin(FLIGHT_ANGLE), z: -Math.cos(FLIGHT_ANGLE) };
}

function build() {
  const nodes: StairNode[] = [];
  const flights: Flight[] = [];
  // Start on the flat path at the foot of the stairs.
  let p: Vec3 = { x: -1.6, y: 0, z: 6 };
  nodes.push({ ...p, kind: "landing", flight: -1 });
  p = { x: -1.6, y: 0, z: 5.2 };
  nodes.push({ ...p, kind: "landing", flight: -1 });
  for (let k = 0; k < FLIGHTS; k++) {
    const d = flightDir(k);
    flights.push({ start: { ...p }, dir: d, treads: TREADS_PER_FLIGHT });
    for (let j = 0; j < TREADS_PER_FLIGHT; j++) {
      p = { x: p.x + d.x * TREAD_RUN, y: p.y + TREAD_RISE, z: p.z + d.z * TREAD_RUN };
      nodes.push({ ...p, kind: "tread", flight: k });
    }
    if (k < FLIGHTS - 1) {
      // Landing: carry on a little, then turn toward the next flight's heading (flat, no rise).
      const n = flightDir(k + 1);
      p = { x: p.x + d.x * LANDING_STEP, y: p.y, z: p.z + d.z * LANDING_STEP };
      nodes.push({ ...p, kind: "landing", flight: k });
      p = { x: p.x + (d.x + n.x) * 0.5 * LANDING_STEP, y: p.y, z: p.z - LANDING_STEP * 0.9 };
      nodes.push({ ...p, kind: "landing", flight: k });
      p = { x: p.x + n.x * LANDING_STEP * 0.5, y: p.y, z: p.z + n.z * LANDING_STEP * 0.5 };
      nodes.push({ ...p, kind: "landing", flight: k });
    }
  }
  // Onto the lookout plaza.
  for (let i = 1; i <= 4; i++) {
    p = { x: p.x * 0.75, y: p.y, z: p.z - 0.7 };
    nodes.push({ ...p, kind: "plaza", flight: FLIGHTS });
  }
  return { nodes, flights };
}

const BUILT = build();
export const STAIR_NODES: readonly StairNode[] = BUILT.nodes;
export const STAIR_FLIGHTS: readonly Flight[] = BUILT.flights;
/** Path parameter of the last node: progress s runs over [0, PATH_END]. */
export const PATH_END = STAIR_NODES.length - 1;
/** Where the stairs end and the lookout plaza begins (progress 1 lands here, then the summit walk finishes). */
export const SUMMIT_NODE = STAIR_NODES.findIndex((n) => n.kind === "plaza");
export const SUMMIT: Vec3 = STAIR_NODES[PATH_END];
export const TOP_Y = SUMMIT.y;
/** The lookout terrace: its front edge sits just past the top tread. */
export const PLAZA = { x: SUMMIT.x, z: SUMMIT.z - 3.4, w: 19, d: 12 };
const inPlaza = (x: number, z: number, margin = 0) => Math.abs(x - PLAZA.x) <= PLAZA.w / 2 + margin && Math.abs(z - PLAZA.z) <= PLAZA.d / 2 + margin;

/** Climb fraction (0..1, from climb.ts) → path parameter. The full fraction stands at the top of the stairs. */
export function progressToPath(fraction: number): number {
  return Math.min(1, Math.max(0, fraction)) * SUMMIT_NODE;
}

/** Ease for one step: the body rises mostly while the leading foot lands, so it never floats between treads. */
function stepEase(t: number) {
  return t * t * (3 - 2 * t);
}

/**
 * Pose at path parameter s: feet position (y = tread top), heading (yaw, radians, 0 = facing +z) and whether
 * this stretch is stairs (for the gait). Integer s is exactly on a node.
 */
export function sampleStair(s: number): Vec3 & { yaw: number; onStairs: boolean } {
  const c = Math.min(PATH_END, Math.max(0, s));
  const i = Math.min(PATH_END - 1, Math.floor(c));
  const t = c - i;
  const a = STAIR_NODES[i];
  const b = STAIR_NODES[i + 1];
  const rise = b.y - a.y;
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + rise * (rise > 0 ? stepEase(t) : t),
    z: a.z + (b.z - a.z) * t,
    yaw: Math.atan2(b.x - a.x, b.z - a.z),
    onStairs: rise > 0,
  };
}

/** Horizontal distance from (x, z) to the walkable path, and the height of the nearest path point. */
export function nearestPath(x: number, z: number): { dist: number; y: number } {
  let best = Infinity;
  let y = 0;
  for (let i = 0; i < PATH_END; i++) {
    const a = STAIR_NODES[i];
    const b = STAIR_NODES[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / len2));
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      y = a.y + (b.y - a.y) * t;
    }
  }
  return { dist: best, y };
}

/** Deterministic value noise (no Math.random) so terrain, trees and tests agree on every device. */
function hash(ix: number, iz: number) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, z: number) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Slope of the mountainside the stairs are cut into, before carving. */
const SLOPE = (TREAD_RISE / (TREAD_RUN * Math.cos(FLIGHT_ANGLE))) * 0.93;
const START_Z = STAIR_NODES[0].z;

function hillside(x: number, z: number) {
  const up = Math.min(TOP_Y + 0.4, Math.max(-0.4, (START_Z - z - 0.8) * SLOPE));
  // Beyond the plaza the summit falls away toward the city (the lookout's view).
  const beyond = Math.max(0, SUMMIT.z - 4 - z);
  const ridge = up - beyond * beyond * 0.06;
  // The hill rises a little to either side, so the stairs sit in a shallow ravine.
  const side = Math.min(6, Math.abs(x) * 0.08) ** 1.4;
  return ridge + side + (noise(x * 0.18, z * 0.18) - 0.5) * 1.6 + (noise(x * 0.6, z * 0.6) - 0.5) * 0.35;
}

/**
 * Ground height at (x, z). Near the path the ground is carved just below the treads, so the stairs and the
 * climber never sink into the hill and the camera can use the same function to stay above ground.
 */
export function terrainHeight(x: number, z: number): number {
  let h = hillside(x, z);
  if (inPlaza(x, z, 0.5)) h = Math.min(h, TOP_Y - 0.4);
  const { dist, y } = nearestPath(x, z);
  const corridor = STAIR_WIDTH * 0.5 + 0.9;
  if (dist >= corridor + 2.5) return h;
  const carved = y - 0.12;
  // Cut into the hill where it is higher, built up (an embankment) where it is lower.
  if (dist <= corridor) return carved;
  const k = (dist - corridor) / 2.5;
  return carved + (h - carved) * k * k * (3 - 2 * k);
}

/** Seeded PRNG (mulberry32) for scenery placement. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type TreeSpot = { x: number; y: number; z: number; scale: number; kind: "conifer" | "broadleaf"; tint: number };

/** Forest placement: deterministic, kept off the stairs and the plaza. */
export function treeSpots(count: number, seed = 7): TreeSpot[] {
  const r = rng(seed);
  const out: TreeSpot[] = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 20) {
    const x = (r() - 0.5) * 64;
    const z = START_Z + 6 - r() * (START_Z - SUMMIT.z + 14);
    const { dist } = nearestPath(x, z);
    // Keep a clearing along the stairs so trunks and canopies never block the follow camera.
    if (dist < STAIR_WIDTH * 0.5 + 3.2 + Math.max(0, x * 0.04)) continue;
    if (inPlaza(x, z, 2)) continue;
    // ...and along the follow camera's track (behind and above the climber, toward +z).
    if (nearestPath(x - 1.2, z - 7.5).dist < 4.5) continue;
    out.push({ x, y: terrainHeight(x, z), z, scale: 0.75 + r() * 0.7, kind: r() < 0.55 ? "broadleaf" : "conifer", tint: r() });
  }
  return out;
}
