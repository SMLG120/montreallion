"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { BoxGeometry, CapsuleGeometry, CylinderGeometry, Group, MeshStandardMaterial, SphereGeometry, TorusGeometry } from "three";
import { DEFAULT_LOOK, option, type Appearance, type Part } from "@/lib/game/climb";

/** Per-frame pose input, computed by the scene rig from the staircase path. */
export type ClimberPose = {
  /** Gait phase in radians: one tread per half cycle on stairs, so each foot lands on its own tread. */
  phase: number;
  moving: boolean;
  onStairs: boolean;
  /** Seconds since a celebration started (summit, legend answer), or -1. */
  celebrate: number;
  /** Seconds since a missed answer (small head shake), or -1. */
  shake: number;
};
export type ClimberHandle = { update: (pose: ClimberPose) => void };

// Shared, tiny geometries: built once per page and reused by every climber render (never per frame).
let G: ReturnType<typeof makeGeometries> | null = null;
function makeGeometries() {
  return {
    thigh: new CapsuleGeometry(0.075, 0.3, 4, 10),
    shin: new CapsuleGeometry(0.065, 0.3, 4, 10),
    foot: new BoxGeometry(0.13, 0.07, 0.26),
    torso: new CapsuleGeometry(0.19, 0.32, 6, 14),
    upperArm: new CapsuleGeometry(0.06, 0.22, 4, 8),
    foreArm: new CapsuleGeometry(0.055, 0.2, 4, 8),
    hand: new SphereGeometry(0.06, 10, 8),
    neck: new CylinderGeometry(0.06, 0.07, 0.1, 10),
    head: new SphereGeometry(0.17, 20, 16),
    eye: new SphereGeometry(0.018, 8, 6),
    nose: new SphereGeometry(0.025, 8, 6),
    cap: new SphereGeometry(0.18, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
    buzz: new SphereGeometry(0.173, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.48),
    hatDome: new SphereGeometry(0.188, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
    curl: new SphereGeometry(0.06, 8, 6),
    bun: new SphereGeometry(0.08, 10, 8),
    pompom: new SphereGeometry(0.055, 10, 8),
    band: new TorusGeometry(0.18, 0.028, 6, 20),
    brim: new BoxGeometry(0.22, 0.02, 0.16),
    longHair: new BoxGeometry(0.3, 0.36, 0.1),
    zip: new BoxGeometry(0.02, 0.5, 0.02),
    pack: new BoxGeometry(0.32, 0.4, 0.16),
    bigPack: new BoxGeometry(0.38, 0.5, 0.22),
    ski: new BoxGeometry(0.05, 1.3, 0.03),
    roll: new CylinderGeometry(0.07, 0.07, 0.42, 10),
    scarf: new TorusGeometry(0.15, 0.05, 8, 18),
    tail: new BoxGeometry(0.08, 0.26, 0.04),
    lens: new TorusGeometry(0.038, 0.009, 6, 14),
    bridge: new BoxGeometry(0.04, 0.008, 0.008),
    phones: new TorusGeometry(0.19, 0.018, 6, 18, Math.PI),
    cup: new CylinderGeometry(0.055, 0.055, 0.05, 12),
    medal: new CylinderGeometry(0.055, 0.055, 0.015, 14),
    lantern: new BoxGeometry(0.09, 0.13, 0.09),
  };
}
const geo = () => (G ??= makeGeometries());

const colorOf = (look: Appearance, part: Part) => option(part, look[part])?.color ?? option(part, DEFAULT_LOOK[part])!.color!;

/**
 * The player's saved 2D look (climb.ts options) rebuilt as a stylized 3D figure: same skin, hair, jacket,
 * pants, hat, pack and accessory ids, so nobody has to recreate their character. Feet at y = 0, facing +z.
 */
export const Climber3D = forwardRef<ClimberHandle, { look: Appearance; shadows: boolean }>(function Climber3D({ look, shadows }, ref) {
  const g = geo();
  const mats = useMemo(() => {
    const m = (color: string, extra: Partial<{ emissive: string; emissiveIntensity: number; roughness: number; metalness: number }> = {}) =>
      new MeshStandardMaterial({ color, roughness: extra.roughness ?? 0.75, metalness: extra.metalness ?? 0, emissive: extra.emissive ?? "#000000", emissiveIntensity: extra.emissiveIntensity ?? 1 });
    return {
      skin: m(colorOf(look, "skin"), { roughness: 0.6 }),
      hair: m(colorOf(look, "hairColor"), { roughness: 0.9 }),
      jacket: m(colorOf(look, "jacket"), { roughness: 0.65 }),
      pants: m(colorOf(look, "pants")),
      dark: m("#14161c", { roughness: 0.4 }),
      white: m("#f4f1ea"),
      boot: m("#2b211b"),
      tuque: m("#c8452c"),
      cap: m("#2f6fdc"),
      beret: m("#1d2433"),
      helmet: m("#e9edf2", { roughness: 0.35 }),
      gold: m("#d4a62a", { roughness: 0.35, metalness: 0.6 }),
      blue: m("#3d5a80"),
      red: m("#c8452c"),
      brown: m("#5b4636"),
      green: m("#2f8a5f"),
      scarf: m("#f2a516"),
      ski: m("#d9d9d9", { roughness: 0.4 }),
      glow: m("#ffd166", { emissive: "#ffb547", emissiveIntensity: 2.2 }),
    };
  }, [look]);
  useEffect(() => () => Object.values(mats).forEach((x) => x.dispose()), [mats]);

  const body = useRef<Group>(null);
  const head = useRef<Group>(null);
  const legL = useRef<Group>(null);
  const legR = useRef<Group>(null);
  const kneeL = useRef<Group>(null);
  const kneeR = useRef<Group>(null);
  const armL = useRef<Group>(null);
  const armR = useRef<Group>(null);
  const elbowL = useRef<Group>(null);
  const elbowR = useRef<Group>(null);

  useImperativeHandle(ref, () => ({
    update({ phase, moving, onStairs, celebrate, shake }) {
      if (!body.current) return;
      const s = Math.sin(phase);
      const amp = moving ? (onStairs ? 0.62 : 0.45) : 0;
      // Hip swing; the forward leg bends at the knee to clear the next tread (more on stairs).
      legL.current!.rotation.x = -s * amp;
      legR.current!.rotation.x = s * amp;
      const lift = onStairs ? 1.1 : 0.6;
      kneeL.current!.rotation.x = moving ? Math.max(0, s) * amp * lift : 0;
      kneeR.current!.rotation.x = moving ? Math.max(0, -s) * amp * lift : 0;
      // Arms counter-swing.
      armL.current!.rotation.set(s * amp * 0.8, 0, 0.08);
      armR.current!.rotation.set(-s * amp * 0.8, 0, -0.08);
      elbowL.current!.rotation.x = moving ? -0.35 : -0.12;
      elbowR.current!.rotation.x = moving ? -0.35 : -0.12;
      body.current.position.y = moving ? Math.abs(Math.cos(phase)) * 0.035 : 0;
      body.current.rotation.x = moving && onStairs ? 0.12 : 0;
      head.current!.rotation.set(moving && onStairs ? -0.08 : 0, 0, 0);
      if (celebrate >= 0) {
        // Arms up and a gentle wave; a small hop at the start.
        const wave = Math.sin(celebrate * 7) * 0.25;
        armL.current!.rotation.set(0, 0, 2.6 + wave);
        armR.current!.rotation.set(0, 0, -2.6 - wave);
        elbowL.current!.rotation.x = 0;
        elbowR.current!.rotation.x = 0;
        body.current.position.y = celebrate < 0.5 ? Math.sin((celebrate / 0.5) * Math.PI) * 0.18 : 0;
      }
      if (shake >= 0 && shake < 0.9) head.current!.rotation.y = Math.sin(shake * 16) * 0.28 * (1 - shake / 0.9);
    },
  }));

  const cast = shadows;
  const hat = look.hat;
  const hair = look.hair;
  const pack = look.pack;
  const acc = look.accessory;

  const leg = (side: 1 | -1, r: React.RefObject<Group | null>, k: React.RefObject<Group | null>) => (
    <group ref={r} position={[0.1 * side, 0.9, 0]}>
      <mesh geometry={g.thigh} material={mats.pants} position={[0, -0.225, 0]} castShadow={cast} />
      <group ref={k} position={[0, -0.45, 0]}>
        <mesh geometry={g.shin} material={mats.pants} position={[0, -0.2, 0]} castShadow={cast} />
        <mesh geometry={g.foot} material={mats.boot} position={[0, -0.415, 0.05]} castShadow={cast} />
      </group>
    </group>
  );
  const arm = (side: 1 | -1, r: React.RefObject<Group | null>, e: React.RefObject<Group | null>, holdsLantern: boolean) => (
    <group ref={r} position={[0.26 * side, 1.5, 0]}>
      <mesh geometry={g.upperArm} material={mats.jacket} position={[0, -0.17, 0]} castShadow={cast} />
      <group ref={e} position={[0, -0.33, 0]}>
        <mesh geometry={g.foreArm} material={mats.jacket} position={[0, -0.15, 0]} castShadow={cast} />
        <mesh geometry={g.hand} material={mats.skin} position={[0, -0.32, 0]} />
        {holdsLantern && <mesh geometry={g.lantern} material={mats.glow} position={[0, -0.45, 0.04]} />}
      </group>
    </group>
  );

  return (
    <group ref={body}>
      {leg(1, legL, kneeL)}
      {leg(-1, legR, kneeR)}
      <mesh geometry={g.torso} material={mats.jacket} position={[0, 1.25, 0]} scale={[1, 1, 0.78]} castShadow={cast} />
      <mesh geometry={g.zip} material={mats.dark} position={[0, 1.22, 0.15]} />
      {arm(1, armL, elbowL, false)}
      {arm(-1, armR, elbowR, acc === "lantern")}
      <mesh geometry={g.neck} material={mats.skin} position={[0, 1.63, 0]} />

      {pack === "daypack" && <mesh geometry={g.pack} material={mats.blue} position={[0, 1.28, -0.22]} castShadow={cast} />}
      {pack === "ski" && (
        <group>
          <mesh geometry={g.pack} material={mats.red} position={[0, 1.28, -0.22]} castShadow={cast} />
          <mesh geometry={g.ski} material={mats.ski} position={[0.08, 1.35, -0.33]} rotation={[0, 0, -0.08]} />
          <mesh geometry={g.ski} material={mats.ski} position={[-0.06, 1.35, -0.33]} rotation={[0, 0, -0.08]} />
        </group>
      )}
      {pack === "explorer" && (
        <group>
          <mesh geometry={g.bigPack} material={mats.brown} position={[0, 1.27, -0.25]} castShadow={cast} />
          <mesh geometry={g.roll} material={mats.green} position={[0, 1.57, -0.25]} rotation={[0, 0, Math.PI / 2]} />
        </group>
      )}

      {(acc === "scarf" || acc === "legend-scarf") && (
        <group position={[0, 1.6, 0]}>
          <mesh geometry={g.scarf} material={acc === "legend-scarf" ? mats.gold : mats.scarf} rotation={[Math.PI / 2, 0, 0]} />
          <mesh geometry={g.tail} material={acc === "legend-scarf" ? mats.gold : mats.scarf} position={[0.07, -0.14, 0.15]} rotation={[0.2, 0, 0.1]} />
        </group>
      )}
      {acc === "medal" && <mesh geometry={g.medal} material={mats.gold} position={[0, 1.38, 0.18]} rotation={[Math.PI / 2, 0, 0]} />}

      <group ref={head} position={[0, 1.8, 0]}>
        <mesh geometry={g.head} material={mats.skin} castShadow={cast} />
        <mesh geometry={g.eye} material={mats.dark} position={[0.06, 0.02, 0.155]} />
        <mesh geometry={g.eye} material={mats.dark} position={[-0.06, 0.02, 0.155]} />
        <mesh geometry={g.nose} material={mats.skin} position={[0, -0.02, 0.17]} />

        {hair === "buzz" ? (
          <mesh geometry={g.buzz} material={mats.hair} rotation={[-0.25, 0, 0]} />
        ) : (
          <mesh geometry={g.cap} material={mats.hair} rotation={[-0.3, 0, 0]} />
        )}
        {hair === "long" && <mesh geometry={g.longHair} material={mats.hair} position={[0, -0.12, -0.11]} />}
        {hair === "curly" &&
          [0, 1, 2, 3, 4, 5, 6].map((i) => {
            const a = (i / 7) * Math.PI * 2;
            return <mesh key={i} geometry={g.curl} material={mats.hair} position={[Math.cos(a) * 0.15, 0.06 + (i % 2) * 0.05, Math.sin(a) * 0.15 - 0.03]} />;
          })}
        {hair === "bun" && <mesh geometry={g.bun} material={mats.hair} position={[0, 0.13, -0.13]} />}

        {(hat === "tuque" || hat === "summit-tuque") && (
          <group position={[0, 0.02, 0]}>
            <mesh geometry={g.hatDome} material={hat === "tuque" ? mats.tuque : mats.gold} scale={[1, 1.15, 1]} />
            <mesh geometry={g.band} material={mats.white} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} />
            <mesh geometry={g.pompom} material={mats.white} position={[0, 0.235, 0]} />
          </group>
        )}
        {hat === "cap" && (
          <group position={[0, 0.02, 0]}>
            <mesh geometry={g.hatDome} material={mats.cap} />
            <mesh geometry={g.brim} material={mats.cap} position={[0, 0.03, 0.2]} />
          </group>
        )}
        {hat === "beret" && <mesh geometry={g.head} material={mats.beret} position={[0.02, 0.13, -0.01]} scale={[1.15, 0.35, 1.15]} rotation={[0, 0, -0.18]} />}
        {hat === "helmet" && (
          <group position={[0, 0.03, 0]}>
            <mesh geometry={g.hatDome} material={mats.helmet} scale={[1.08, 1.05, 1.12]} />
            <mesh geometry={g.brim} material={mats.red} position={[0, 0.19, 0]} scale={[0.25, 1, 1.6]} />
          </group>
        )}

        {acc === "glasses" && (
          <group position={[0, 0.02, 0.165]}>
            <mesh geometry={g.lens} material={mats.dark} position={[0.06, 0, 0]} />
            <mesh geometry={g.lens} material={mats.dark} position={[-0.06, 0, 0]} />
            <mesh geometry={g.bridge} material={mats.dark} />
          </group>
        )}
        {acc === "headphones" && (
          <group>
            <mesh geometry={g.phones} material={mats.dark} />
            <mesh geometry={g.cup} material={mats.dark} position={[0.18, 0, 0]} rotation={[0, 0, Math.PI / 2]} />
            <mesh geometry={g.cup} material={mats.dark} position={[-0.18, 0, 0]} rotation={[0, 0, Math.PI / 2]} />
          </group>
        )}
      </group>
    </group>
  );
});
