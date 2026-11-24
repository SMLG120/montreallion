"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  InstancedMesh,
  MathUtils,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  RepeatWrapping,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from "three";
import { climbFraction, type Appearance, type Move } from "@/lib/game/climb";
import {
  PATH_END,
  PLAZA,
  STAIR_FLIGHTS,
  STAIR_NODES,
  STAIR_WIDTH,
  SUMMIT,
  SUMMIT_NODE,
  TOP_Y,
  TREAD_RISE,
  TREAD_RUN,
  nearestPath,
  progressToPath,
  rng,
  sampleStair,
  terrainHeight,
  treeSpots,
} from "@/lib/game/stair3d";
import { Climber3D, type ClimberHandle, type ClimberPose } from "./climber-3d";

export type Quality = "low" | "high";

export type ClimbSceneProps = {
  /** Server-confirmed climb steps (sum of correct scores). The climber only ever moves toward this. */
  steps: number;
  /** Index of the newest answered stop (-1 before the first). Animation runs only when it advances by one. */
  lastIndex: number;
  /** False when the latest stop was restored (reload) rather than answered live: stand still, don't replay. */
  animate?: boolean;
  lastMove: Move;
  lastMissed: boolean;
  finished: boolean;
  /** Pre-game: the camera shows the climber's face at the foot of the stairs. */
  intro: boolean;
  look: Appearance;
  quality: Quality;
  reduceMotion: boolean;
  resetKey: number;
  /** Pixels covered by the game panel (left column / bottom sheet); the shot is re-centred on the rest. */
  inset: { left: number; bottom: number; top: number };
  onContextLost: () => void;
  /** Measured during movement: frames per second and draw calls (for adaptive quality and QA). */
  onStats?: (s: { fps: number; calls: number }) => void;
};

/** Nodes per second while climbing: rarer answers climb faster and farther (distance is the score). */
const SPEED: Record<Move, number> = { none: 0, short: 4.2, big: 6, leap: 9 };
const MAX_CLIMB_S = 6;

export default function ClimbScene(props: ClimbSceneProps) {
  const high = props.quality === "high";
  // R3F force-loses the context when the canvas unmounts (e.g. a quality switch); that is not a device failure.
  const alive = useRef(true);
  const onLost = useRef(props.onContextLost);
  useEffect(() => {
    onLost.current = props.onContextLost;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <Canvas
      frameloop="demand"
      shadows={high ? "percentage" : false}
      dpr={high ? [1, 2] : [1, 1.25]}
      gl={{ antialias: high, powerPreference: high ? "high-performance" : "low-power" }}
      camera={{ fov: 50, near: 0.1, far: 700, position: [0, 4, 14] }}
      onCreated={({ gl }) => {
        gl.domElement.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          if (alive.current) onLost.current();
        });
      }}
      style={{ touchAction: "none" }}
      aria-hidden
      data-testid="climb-canvas"
    >
      <color attach="background" args={["#121b38"]} />
      <fog attach="fog" args={["#1d2a52", 30, high ? 230 : 160]} />
      <hemisphereLight args={["#9fb4ff", "#1d3b2a", 0.85]} />
      <Sun shadows={high} />
      <Sky />
      <Terrain segments={high ? 150 : 90} />
      <Stairs />
      <Forest count={high ? 460 : 190} />
      <Rocks count={high ? 70 : 30} />
      <Lookout />
      <City count={high ? 150 : 80} />
      <Framing inset={props.inset} />
      <Rig {...props} shadows={high} />
    </Canvas>
  );
}

/** Shifts the projection centre so the climber sits in the visible part of the screen, not under the panel. */
function Framing({ inset }: { inset: { left: number; bottom: number; top: number } }) {
  const { camera, size, invalidate } = useThree();
  useLayoutEffect(() => {
    const cam = camera as PerspectiveCamera;
    const x = -Math.min(inset.left, size.width * 0.5) / 2;
    // Centre of the uncovered band between the HUD (top) and the panel (bottom).
    const y = (Math.min(inset.bottom, size.height * 0.65) - Math.min(inset.top, size.height * 0.3)) / 2;
    if (x || y) cam.setViewOffset(size.width, size.height, x, y, size.width, size.height);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
    invalidate();
  }, [camera, size.width, size.height, inset.left, inset.bottom, inset.top, invalidate]);
  return null;
}

// ------------------------------------------------------------------ lights + sky

function Sun({ shadows }: { shadows: boolean }) {
  const light = useRef<DirectionalLight>(null);
  const { scene } = useThree();
  useLayoutEffect(() => {
    const l = light.current!;
    scene.add(l.target);
    return () => void scene.remove(l.target);
  }, [scene]);
  useFrame(() => {
    // The shadow camera follows the climber so a small (cheap) shadow map stays sharp where it matters.
    const c = scene.getObjectByName("climber");
    if (!c || !light.current) return;
    light.current.position.set(c.position.x - 8, c.position.y + 14, c.position.z + 6);
    light.current.target.position.copy(c.position);
  });
  return (
    <directionalLight
      ref={light}
      color="#ffd9a8"
      intensity={1.5}
      castShadow={shadows}
      shadow-mapSize={[1024, 1024]}
      shadow-camera-left={-9}
      shadow-camera-right={9}
      shadow-camera-top={9}
      shadow-camera-bottom={-9}
      shadow-camera-near={1}
      shadow-camera-far={40}
      shadow-bias={-0.0006}
    />
  );
}

function Sky() {
  const geom = useMemo(() => {
    const g = new SphereGeometry(400, 24, 16);
    const top = new Color("#0b1230");
    const mid = new Color("#2a3d78");
    const glow = new Color("#f08a5d");
    const pos = g.getAttribute("position");
    const col = new Float32Array(pos.count * 3);
    const c = new Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 400;
      const z = pos.getZ(i) / 400;
      // Warm dusk glow low over the city (−z), deep blue overhead.
      c.copy(mid).lerp(top, MathUtils.clamp(y * 1.6, 0, 1));
      const g2 = MathUtils.clamp(1 - Math.abs(y - 0.02) * 7, 0, 1) * MathUtils.clamp(-z, 0, 1);
      c.lerp(glow, g2 * 0.75);
      col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute("color", new BufferAttribute(col, 3));
    return g;
  }, []);
  const stars = useMemo(() => {
    const r = rng(11);
    const n = 380;
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const e = 0.18 + r() * 1.3;
      p.set([Math.cos(a) * Math.cos(e) * 380, Math.sin(e) * 380, Math.sin(a) * Math.cos(e) * 380], i * 3);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(p, 3));
    return g;
  }, []);
  useEffect(() => () => (geom.dispose(), stars.dispose()), [geom, stars]);
  return (
    <group>
      <mesh geometry={geom} renderOrder={-1}>
        <meshBasicMaterial vertexColors side={BackSide} fog={false} depthWrite={false} />
      </mesh>
      <points geometry={stars}>
        <pointsMaterial color="#ffffff" size={1.6} sizeAttenuation={false} fog={false} transparent opacity={0.8} />
      </points>
    </group>
  );
}

// ------------------------------------------------------------------ terrain

const Z_FRONT = STAIR_NODES[0].z + 14;
const Z_BACK = SUMMIT.z - 30;

function Terrain({ segments }: { segments: number }) {
  const geom = useMemo(() => {
    const w = 96;
    const d = Z_FRONT - Z_BACK;
    const g = new PlaneGeometry(w, d, segments, Math.round(segments * (d / w)));
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, (Z_FRONT + Z_BACK) / 2);
    const pos = g.getAttribute("position");
    const col = new Float32Array(pos.count * 3);
    const grass = new Color("#2b5e3c");
    const moss = new Color("#3f7a46");
    const dirt = new Color("#6b5a43");
    const rock = new Color("#5c5f63");
    const c = new Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = terrainHeight(x, z);
      pos.setY(i, y);
      const { dist } = nearestPath(x, z);
      c.copy(grass).lerp(moss, (Math.sin(x * 0.7) * Math.cos(z * 0.5) + 1) * 0.25);
      if (dist < STAIR_WIDTH * 0.5 + 1.1) c.lerp(dirt, 1 - dist / (STAIR_WIDTH * 0.5 + 1.1));
      if (z < SUMMIT.z - 6) c.lerp(rock, MathUtils.clamp((SUMMIT.z - 6 - z) / 14, 0, 0.7));
      col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute("color", new BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  }, [segments]);
  useEffect(() => () => geom.dispose(), [geom]);
  return (
    <mesh geometry={geom} receiveShadow>
      <meshLambertMaterial vertexColors flatShading />
    </mesh>
  );
}

// ------------------------------------------------------------------ instancing helpers

const tmp = new Object3D();
const tmpColor = new Color();

function useInstances(ref: React.RefObject<InstancedMesh | null>, count: number, place: (i: number, o: Object3D, c: Color) => void, deps: unknown[]) {
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    for (let i = 0; i < count; i++) {
      tmp.position.set(0, 0, 0);
      tmp.rotation.set(0, 0, 0);
      tmp.scale.set(1, 1, 1);
      tmpColor.set("#ffffff");
      place(i, tmp, tmpColor);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      m.setColorAt(i, tmpColor);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// ------------------------------------------------------------------ stairs

const TREADS = STAIR_NODES.filter((n) => n.kind === "tread");
const LANDINGS = STAIR_NODES.filter((n) => n.kind === "landing");

function Stairs() {
  const treads = useRef<InstancedMesh>(null);
  const landings = useRef<InstancedMesh>(null);
  const posts = useRef<InstancedMesh>(null);
  const rails = useRef<InstancedMesh>(null);
  const walls = useRef<InstancedMesh>(null);
  const lamps = useRef<InstancedMesh>(null);
  const bulbs = useRef<InstancedMesh>(null);
  const r = useMemo(() => rng(3), []);

  const postSpots = useMemo(() => {
    const out: { x: number; y: number; z: number }[] = [];
    STAIR_FLIGHTS.forEach((f, k) => {
      const nodes = TREADS.filter((n) => n.flight === k);
      nodes.forEach((n, j) => {
        if (j % 4 !== 0 && j !== nodes.length - 1) return;
        for (const side of [1, -1]) {
          out.push({ x: n.x + f.dir.z * side * -(STAIR_WIDTH / 2 + 0.05), y: n.y, z: n.z + f.dir.x * side * (STAIR_WIDTH / 2 + 0.05) });
        }
      });
    });
    return out;
  }, []);

  useInstances(treads, TREADS.length, (i, o, c) => {
    const n = TREADS[i];
    const f = STAIR_FLIGHTS[n.flight];
    o.position.set(n.x, n.y - 0.6, n.z);
    o.rotation.y = Math.atan2(f.dir.x, f.dir.z);
    c.setHSL(0.09, 0.08, 0.5 + r() * 0.12);
  }, []);
  useInstances(landings, LANDINGS.length, (i, o, c) => {
    const n = LANDINGS[i];
    o.position.set(n.x, n.y - 0.6, n.z);
    c.setHSL(0.09, 0.07, 0.47 + r() * 0.08);
  }, []);
  useInstances(posts, postSpots.length, (i, o) => {
    const p = postSpots[i];
    o.position.set(p.x, p.y + 0.45, p.z);
  }, [postSpots]);
  // Two handrails and two low side walls per flight, sloped with the stairs.
  const flightRails = useMemo(
    () =>
      STAIR_FLIGHTS.flatMap((f, k) => {
        const nodes = TREADS.filter((n) => n.flight === k);
        const a = nodes[0];
        const b = nodes[nodes.length - 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const pitch = Math.atan2(b.y - a.y, len);
        return [1, -1].map((side) => ({
          x: (a.x + b.x) / 2 + f.dir.z * side * -(STAIR_WIDTH / 2 + 0.05),
          y: (a.y + b.y) / 2,
          z: (a.z + b.z) / 2 + f.dir.x * side * (STAIR_WIDTH / 2 + 0.05),
          yaw: Math.atan2(f.dir.x, f.dir.z),
          pitch,
          len: Math.hypot(len, b.y - a.y) + TREAD_RUN,
        }));
      }),
    [],
  );
  useInstances(rails, flightRails.length, (i, o) => {
    const q = flightRails[i];
    o.position.set(q.x, q.y + 0.92, q.z);
    o.rotation.set(0, q.yaw, 0, "YXZ");
    o.rotateX(-q.pitch);
    o.scale.set(1, 1, q.len);
  }, [flightRails]);
  useInstances(walls, flightRails.length, (i, o) => {
    const q = flightRails[i];
    o.position.set(q.x, q.y - 0.05, q.z);
    o.rotation.set(0, q.yaw, 0, "YXZ");
    o.rotateX(-q.pitch);
    o.scale.set(1, 1, q.len);
  }, [flightRails]);
  // A lamp at every landing (the warm lights along the climb).
  const lampSpots = useMemo(() => LANDINGS.filter((_, i) => i % 3 === 1).map((n) => ({ x: n.x + 1.25, y: n.y, z: n.z })), []);
  useInstances(lamps, lampSpots.length, (i, o) => o.position.set(lampSpots[i].x, lampSpots[i].y + 1.3, lampSpots[i].z), [lampSpots]);
  useInstances(bulbs, lampSpots.length, (i, o) => o.position.set(lampSpots[i].x, lampSpots[i].y + 2.65, lampSpots[i].z), [lampSpots]);

  return (
    <group>
      <instancedMesh ref={treads} args={[undefined, undefined, TREADS.length]} receiveShadow>
        <boxGeometry args={[STAIR_WIDTH, 1.2, TREAD_RUN + 0.03]} />
        <meshStandardMaterial roughness={0.95} />
      </instancedMesh>
      <instancedMesh ref={landings} args={[undefined, undefined, LANDINGS.length]} receiveShadow>
        <boxGeometry args={[2.1, 1.2, 1.1]} />
        <meshStandardMaterial roughness={0.95} />
      </instancedMesh>
      <instancedMesh ref={posts} args={[undefined, undefined, postSpots.length]}>
        <cylinderGeometry args={[0.03, 0.03, 0.9, 6]} />
        <meshStandardMaterial color="#2b2f36" metalness={0.5} roughness={0.5} />
      </instancedMesh>
      <instancedMesh ref={rails} args={[undefined, undefined, flightRails.length]}>
        <boxGeometry args={[0.05, 0.05, 1]} />
        <meshStandardMaterial color="#3a3f48" metalness={0.5} roughness={0.45} />
      </instancedMesh>
      <instancedMesh ref={walls} args={[undefined, undefined, flightRails.length]} receiveShadow>
        <boxGeometry args={[0.16, 0.5 + TREAD_RISE, 1]} />
        <meshStandardMaterial color="#77705f" roughness={1} />
      </instancedMesh>
      <instancedMesh ref={lamps} args={[undefined, undefined, lampSpots.length]}>
        <cylinderGeometry args={[0.04, 0.05, 2.6, 6]} />
        <meshStandardMaterial color="#1f2329" />
      </instancedMesh>
      <instancedMesh ref={bulbs} args={[undefined, undefined, lampSpots.length]}>
        <sphereGeometry args={[0.13, 10, 8]} />
        <meshStandardMaterial color="#ffe2a8" emissive="#ffb547" emissiveIntensity={2.5} />
      </instancedMesh>
    </group>
  );
}

// ------------------------------------------------------------------ forest + rocks

function Forest({ count }: { count: number }) {
  const spots = useMemo(() => treeSpots(count), [count]);
  const conifers = useMemo(() => spots.filter((t) => t.kind === "conifer"), [spots]);
  const broad = useMemo(() => spots.filter((t) => t.kind === "broadleaf"), [spots]);
  const trunks = useRef<InstancedMesh>(null);
  const coneLow = useRef<InstancedMesh>(null);
  const coneHigh = useRef<InstancedMesh>(null);
  const crowns = useRef<InstancedMesh>(null);

  useInstances(trunks, spots.length, (i, o, c) => {
    const t = spots[i];
    o.position.set(t.x, t.y + 0.9 * t.scale, t.z);
    o.scale.set(t.scale, t.scale, t.scale);
    c.set("#4a3626");
  }, [spots]);
  const green = (t: number, c: Color) => {
    // Mostly greens with a share of autumn maples, as on the mountain in October.
    if (t > 0.84) c.setHSL(0.07 + (t - 0.84) * 0.5, 0.75, 0.45);
    else c.setHSL(0.3 + t * 0.07, 0.45, 0.22 + t * 0.12);
  };
  useInstances(coneLow, conifers.length, (i, o, c) => {
    const t = conifers[i];
    o.position.set(t.x, t.y + 2.2 * t.scale, t.z);
    o.scale.set(t.scale, t.scale, t.scale);
    c.setHSL(0.36, 0.42, 0.18 + t.tint * 0.08);
  }, [conifers]);
  useInstances(coneHigh, conifers.length, (i, o, c) => {
    const t = conifers[i];
    o.position.set(t.x, t.y + 3.4 * t.scale, t.z);
    o.scale.set(t.scale * 0.72, t.scale * 0.8, t.scale * 0.72);
    c.setHSL(0.36, 0.42, 0.22 + t.tint * 0.08);
  }, [conifers]);
  useInstances(crowns, broad.length, (i, o, c) => {
    const t = broad[i];
    o.position.set(t.x, t.y + 2.7 * t.scale, t.z);
    o.scale.set(t.scale * (1 + t.tint * 0.3), t.scale * 0.9, t.scale);
    o.rotation.y = t.tint * 6;
    green(t.tint, c);
  }, [broad]);

  return (
    <group>
      <instancedMesh ref={trunks} args={[undefined, undefined, spots.length]}>
        <cylinderGeometry args={[0.1, 0.16, 1.8, 6]} />
        <meshLambertMaterial />
      </instancedMesh>
      <instancedMesh ref={coneLow} args={[undefined, undefined, conifers.length]}>
        <coneGeometry args={[1.3, 2.6, 7]} />
        <meshLambertMaterial flatShading />
      </instancedMesh>
      <instancedMesh ref={coneHigh} args={[undefined, undefined, conifers.length]}>
        <coneGeometry args={[1.1, 2.2, 7]} />
        <meshLambertMaterial flatShading />
      </instancedMesh>
      <instancedMesh ref={crowns} args={[undefined, undefined, broad.length]}>
        <icosahedronGeometry args={[1.45, 0]} />
        <meshLambertMaterial flatShading />
      </instancedMesh>
    </group>
  );
}

function Rocks({ count }: { count: number }) {
  const ref = useRef<InstancedMesh>(null);
  const spots = useMemo(() => {
    const r = rng(5);
    const out: { x: number; z: number; s: number; rot: number }[] = [];
    let guard = 0;
    while (out.length < count && guard++ < count * 30) {
      // Boulders cluster along the stair corridor's edges.
      const n = STAIR_NODES[Math.floor(r() * STAIR_NODES.length)];
      const x = n.x + (r() - 0.5) * 9;
      const z = n.z + (r() - 0.5) * 4;
      if (nearestPath(x, z).dist < STAIR_WIDTH * 0.5 + 0.5) continue;
      if (nearestPath(x - 1.2, z - 7.5).dist < 3) continue; // off the camera track
      if (Math.abs(x - PLAZA.x) < PLAZA.w / 2 + 1 && Math.abs(z - PLAZA.z) < PLAZA.d / 2 + 1) continue;
      out.push({ x, z, s: 0.15 + r() * 0.4, rot: r() * 6 });
    }
    return out;
  }, [count]);
  useInstances(ref, spots.length, (i, o, c) => {
    const p = spots[i];
    o.position.set(p.x, terrainHeight(p.x, p.z) + p.s * 0.25, p.z);
    o.scale.set(p.s * 1.3, p.s * 0.8, p.s);
    o.rotation.set(p.rot, p.rot * 2, 0);
    c.setHSL(0.6, 0.04, 0.38 + (p.rot % 1) * 0.12);
  }, [spots]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, spots.length]} receiveShadow>
      <dodecahedronGeometry args={[1, 0]} />
      <meshLambertMaterial flatShading />
    </instancedMesh>
  );
}

// ------------------------------------------------------------------ lookout + city

/** An original, stylized summit plaza and pavilion with a stone balustrade (not a model of the real chalet). */
function Lookout() {
  const posts = useRef<InstancedMesh>(null);
  const { x: cx, z: cz, w, d } = PLAZA;
  const N = 26;
  const edge = cz - d / 2 + 0.4;
  useInstances(posts, N, (i, o) => o.position.set(cx - w / 2 + 0.5 + (i / (N - 1)) * (w - 1), TOP_Y + 0.45, edge), []);
  return (
    <group>
      <mesh position={[cx, TOP_Y - 0.35, cz]} receiveShadow>
        <boxGeometry args={[w, 0.7, d]} />
        <meshStandardMaterial color="#b7ab95" roughness={0.9} />
      </mesh>
      <instancedMesh ref={posts} args={[undefined, undefined, N]}>
        <boxGeometry args={[0.16, 0.9, 0.16]} />
        <meshStandardMaterial color="#d8ccb0" roughness={0.9} />
      </instancedMesh>
      <mesh position={[cx, TOP_Y + 0.95, edge]}>
        <boxGeometry args={[w - 0.6, 0.14, 0.32]} />
        <meshStandardMaterial color="#d8ccb0" roughness={0.9} />
      </mesh>
      {/* Pavilion to the side of the terrace. */}
      <group position={[cx + 6.5, TOP_Y, cz + 2.5]}>
        <mesh position={[0, 1.7, 0]} castShadow receiveShadow>
          <boxGeometry args={[5.4, 3.4, 3.6]} />
          <meshStandardMaterial color="#c4b08a" roughness={0.85} />
        </mesh>
        <mesh position={[0, 4.15, 0]} rotation={[0, 0, 0]} scale={[1, 0.75, 1]}>
          <cylinderGeometry args={[2.35, 2.35, 5.9, 3, 1, false, Math.PI / 2]} />
          <meshStandardMaterial color="#7a3b2e" roughness={0.8} />
        </mesh>
        {[-1.6, 0, 1.6].map((x) => (
          <mesh key={x} position={[x, 1.9, -1.82]}>
            <boxGeometry args={[0.9, 1.4, 0.05]} />
            <meshStandardMaterial color="#ffd166" emissive="#ffb547" emissiveIntensity={1.6} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function windowTexture() {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 64;
  const x = c.getContext("2d")!;
  x.fillStyle = "#000";
  x.fillRect(0, 0, 32, 64);
  const r = rng(21);
  for (let row = 0; row < 16; row++)
    for (let col = 0; col < 8; col++) {
      if (r() < 0.45) continue;
      x.fillStyle = r() < 0.8 ? "#ffb547" : "#cfe3ff";
      x.globalAlpha = 0.5 + r() * 0.5;
      x.fillRect(col * 4 + 1, row * 4 + 1, 2, 2);
    }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

/** Generic downtown towers seen past the lookout, with warm lit windows: an evocation, not specific buildings. */
function City({ count }: { count: number }) {
  const ref = useRef<InstancedMesh>(null);
  const tex = useMemo(() => windowTexture(), []);
  useEffect(() => () => tex.dispose(), [tex]);
  const blocks = useMemo(() => {
    const r = rng(9);
    return Array.from({ length: count }, () => {
      const x = (r() - 0.5) * 220;
      const z = SUMMIT.z - 55 - r() * 120;
      const core = Math.exp(-((x - 8) ** 2) / 1800 - (z - (SUMMIT.z - 95)) ** 2 / 2200);
      return { x, z, w: 5 + r() * 9, d: 5 + r() * 9, h: 6 + r() * 18 + core * (40 + r() * 70) };
    });
  }, [count]);
  useInstances(ref, blocks.length, (i, o, c) => {
    const b = blocks[i];
    o.position.set(b.x, -14 + b.h / 2, b.z);
    o.scale.set(b.w, b.h, b.d);
    c.setHSL(0.63, 0.25, 0.16 + (i % 5) * 0.015);
  }, [blocks]);
  return (
    <group>
      <instancedMesh ref={ref} args={[undefined, undefined, blocks.length]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshLambertMaterial emissiveMap={tex} emissive="#ffffff" emissiveIntensity={0.9} />
      </instancedMesh>
      <mesh position={[0, -14, SUMMIT.z - 110]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[520, 200]} />
        <meshLambertMaterial color="#141c33" />
      </mesh>
      {/* The river beyond downtown. */}
      <mesh position={[0, -13.9, SUMMIT.z - 205]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[700, 50]} />
        <meshStandardMaterial color="#1f3a66" roughness={0.25} metalness={0.4} />
      </mesh>
    </group>
  );
}

// ------------------------------------------------------------------ climber rig + camera

function Rig({ steps, lastIndex, animate = true, lastMove, lastMissed, finished, intro, look, reduceMotion, resetKey, onStats, shadows }: ClimbSceneProps & { shadows: boolean }) {
  const { camera, gl, invalidate } = useThree();
  const root = useRef<Group>(null);
  const climber = useRef<ClimberHandle>(null);
  const burst = useRef<Points>(null);

  const target = progressToPath(climbFraction(steps));
  const st = useRef({
    s: target,
    goal: target,
    speed: SPEED.short,
    leap: false,
    phase: 0,
    celebrate: -1,
    shake: -1,
    burstT: -1,
    seenIndex: lastIndex,
    yawOff: 0,
    pitchOff: 0,
    zoom: 1,
    yaw: 0,
    frames: 0,
    frameTime: 0,
    snapCamera: true,
    lastInteract: 0,
  });

  // New server-confirmed progress: climb only when exactly one more stop was answered; otherwise (restored ride,
  // reload) stand where the ride is, without replaying the climb.
  useEffect(() => {
    const s = st.current;
    const advanced = animate && lastIndex === s.seenIndex + 1;
    s.seenIndex = lastIndex;
    const goal = finished && target >= SUMMIT_NODE ? PATH_END : target;
    if (!advanced) {
      s.s = goal;
      s.goal = goal;
      s.snapCamera = true;
    } else if (goal > s.s) {
      s.goal = goal;
      const dist = goal - s.s;
      s.speed = Math.max(SPEED[lastMove] || SPEED.short, dist / MAX_CLIMB_S) * (reduceMotion ? 2.5 : 1);
      s.leap = lastMove === "leap" && !reduceMotion;
      if (!reduceMotion && (lastMove === "leap" || lastMove === "big")) s.burstT = lastMove === "leap" ? 0 : -1;
    } else if (lastMissed && !reduceMotion) {
      s.shake = 0;
    }
    invalidate();
  }, [lastIndex, animate, target, finished, lastMove, lastMissed, reduceMotion, invalidate]);

  useEffect(() => {
    const s = st.current;
    s.yawOff = 0;
    s.pitchOff = 0;
    s.zoom = 1;
    invalidate();
  }, [resetKey, invalidate]);
  useEffect(() => invalidate(), [intro, look, invalidate]);

  // Limited orbit + zoom while idle: drag, wheel, pinch. Movement re-frames the shot automatically.
  useEffect(() => {
    const el = gl.domElement;
    const pts = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const s = st.current;
    const down = (e: PointerEvent) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d0 = Math.hypot(a.x - b.x, a.y - b.y);
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const [c, d] = [...pts.values()];
        const d1 = Math.hypot(c.x - d.x, c.y - d.y);
        if (pinch && d0) s.zoom = MathUtils.clamp(s.zoom * (d0 / d1), 0.6, 1.7);
        pinch = 1;
      } else {
        s.yawOff = MathUtils.clamp(s.yawOff - (e.clientX - p.x) * 0.006, -0.75, 0.75);
        s.pitchOff = MathUtils.clamp(s.pitchOff + (e.clientY - p.y) * 0.004, -0.25, 0.4);
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      s.lastInteract = performance.now();
      invalidate();
    };
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = 0;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      s.zoom = MathUtils.clamp(s.zoom * Math.exp(e.deltaY * 0.0012), 0.6, 1.7);
      s.lastInteract = performance.now();
      invalidate();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
    };
  }, [gl, invalidate]);

  const burstGeom = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(90 * 3), 3));
    const col = new Float32Array(90 * 3);
    const palette = ["#ffd166", "#4cc38a", "#5ec8ff", "#ff7eb6"].map((h) => new Color(h));
    for (let i = 0; i < 90; i++) col.set(palette[i % 4].toArray(), i * 3);
    g.setAttribute("color", new BufferAttribute(col, 3));
    return g;
  }, []);
  const burstDirs = useMemo(() => {
    const r = rng(17);
    return Array.from({ length: 90 }, () => new Vector3(r() - 0.5, r() * 0.9 + 0.3, r() - 0.5).normalize().multiplyScalar(2 + r() * 2.5));
  }, []);
  useEffect(() => () => burstGeom.dispose(), [burstGeom]);

  // Scratch vectors, mutated every frame (refs, so React never treats them as render values).
  const v = useRef({ cam: new Vector3(), look: new Vector3(), desired: new Vector3(), focus: new Vector3(), ahead: new Vector3() });

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const s = st.current;
    const { desired, focus, ahead } = v.current;
    const camPos = { current: v.current.cam };
    const look3 = { current: v.current.look };
    let busy = false;

    // Travel along verified staircase waypoints toward the confirmed goal (never past it, never backward).
    const moving = s.s < s.goal - 1e-4;
    if (!moving) {
      s.frames = 0;
      s.frameTime = 0;
    }
    const ds = state.gl.domElement.dataset;
    if (!moving && ds.s !== s.s.toFixed(2)) {
      // Settled position and GPU resource counts, for QA (leak checks) and tests.
      ds.s = s.s.toFixed(2);
      ds.geometries = String(state.gl.info.memory.geometries);
      ds.textures = String(state.gl.info.memory.textures);
    }
    if (moving) {
      const ds = Math.min(s.goal - s.s, s.speed * dt);
      s.s += ds;
      s.phase += ds * Math.PI; // one tread per half gait cycle
      busy = true;
      if (s.s >= s.goal - 1e-4 && s.goal >= SUMMIT_NODE) {
        s.celebrate = 0;
        if (!reduceMotion) s.burstT = 0;
      }
      // Frame-rate sample: only consecutive moving frames. The first frame after an idle gap carries the whole
      // gap (frameloop="demand"), so it's skipped, and a window never spans two climbs.
      if (rawDt < 0.25) {
        s.frames++;
        s.frameTime += rawDt;
      }
      if (s.frames >= 45) {
        onStats?.({ fps: s.frames / s.frameTime, calls: state.gl.info.render.calls });
        s.frames = 0;
        s.frameTime = 0;
      }
    }
    const p = sampleStair(s.s);
    let hop = 0;
    if (moving && s.leap) hop = Math.abs(Math.sin(s.s * Math.PI * 0.5)) * 0.22;
    // Heading: smooth turn at landings; face the camera in the pre-game preview.
    const wantYaw = intro && !moving ? Math.PI + 0.35 : p.yaw;
    let dy = wantYaw - s.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    s.yaw += dy * (1 - Math.exp(-dt * (reduceMotion ? 20 : 9)));
    if (Math.abs(dy) > 0.002) busy = true;
    if (root.current) {
      root.current.position.set(p.x, p.y + hop, p.z);
      root.current.rotation.y = s.yaw;
    }
    if (s.celebrate >= 0) {
      s.celebrate += dt;
      if (s.celebrate > (reduceMotion ? 0.6 : 3)) s.celebrate = -1;
      else busy = true;
    }
    if (s.shake >= 0) {
      s.shake += dt;
      if (s.shake > 0.9) s.shake = -1;
      else busy = true;
    }
    const pose: ClimberPose = { phase: s.phase, moving, onStairs: p.onStairs, celebrate: reduceMotion ? -1 : s.celebrate, shake: s.shake };
    climber.current?.update(pose);

    // Celebration particles.
    if (burst.current) {
      if (s.burstT >= 0) {
        s.burstT += dt;
        const k = s.burstT;
        const pos = burstGeom.getAttribute("position") as BufferAttribute;
        for (let i = 0; i < burstDirs.length; i++) {
          const d = burstDirs[i];
          pos.setXYZ(i, p.x + d.x * k, p.y + 1.6 + d.y * k - 2.4 * k * k, p.z + d.z * k);
        }
        pos.needsUpdate = true;
        burst.current.visible = k < 1.4;
        if (k >= 1.4) s.burstT = -1;
        busy = true;
      } else burst.current.visible = false;
    }

    // Camera: behind (+z) and above the climber, looking up the mountain; framing a little of the stairs ahead.
    if (moving) {
      // Re-frame automatically during movement.
      const k = 1 - Math.exp(-dt * 1.6);
      s.yawOff += (0 - s.yawOff) * k;
      s.pitchOff += (0 - s.pitchOff) * k;
      s.zoom += (1 - s.zoom) * k;
    }
    const a = sampleStair(Math.min(PATH_END, s.s + 10));
    ahead.set(a.x, a.y, a.z);
    focus.set(p.x, p.y + 1.1, p.z).lerp(ahead.setY(ahead.y + 1.1), intro ? 0 : 0.3);
    const az = (intro ? Math.PI * 0.86 : 0.16) + s.yawOff;
    const el = (intro ? 0.22 : 0.44) + s.pitchOff;
    // Portrait screens: pull back so the climber and the stairs ahead both fit the narrow frame.
    const portrait = state.size.width < state.size.height ? 1.3 : 1;
    const dist = (intro ? 5.2 : 9) * s.zoom * portrait;
    desired.set(focus.x + Math.sin(az) * Math.cos(el) * dist, focus.y + Math.sin(el) * dist, focus.z + Math.cos(az) * Math.cos(el) * dist);
    // Never below the hillside (no clipping through terrain).
    desired.y = Math.max(desired.y, terrainHeight(desired.x, desired.z) + 0.9);
    if (s.snapCamera) {
      camPos.current.copy(desired);
      look3.current.copy(focus);
      s.snapCamera = false;
    } else {
      const k = 1 - Math.exp(-dt * (reduceMotion ? 10 : 2.6));
      camPos.current.lerp(desired, k);
      look3.current.lerp(focus, k);
    }
    camPos.current.y = Math.max(camPos.current.y, terrainHeight(camPos.current.x, camPos.current.z) + 0.6);
    camera.position.copy(camPos.current);
    camera.lookAt(look3.current);
    if (camPos.current.distanceToSquared(desired) > 1e-4 || look3.current.distanceToSquared(focus) > 1e-4) busy = true;

    if (busy) state.invalidate();
  });

  return (
    <group>
      <group ref={root} name="climber">
        <Climber3D ref={climber} look={look} shadows={shadows} />
        {!shadows && (
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
            <circleGeometry args={[0.32, 16]} />
            <meshBasicMaterial color="#000000" transparent opacity={0.32} depthWrite={false} />
          </mesh>
        )}
      </group>
      <points ref={burst} geometry={burstGeom} visible={false} frustumCulled={false}>
        <pointsMaterial size={0.14} vertexColors transparent opacity={0.95} depthWrite={false} />
      </points>
    </group>
  );
}

