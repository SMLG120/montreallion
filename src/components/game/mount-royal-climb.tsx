"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Palette } from "lucide-react";
import { useApp } from "@/components/providers";
import { TIER_LABELS } from "@/lib/i18n/dict";
import { TIER_COLOR } from "@/lib/client/fx";
import {
  DEFAULT_LOOK, HATS, JACKETS, SKINS, STAIR, SUMMIT_STEPS, WORLD,
  bestTier, climbFraction, climbSteps, moveFor, parseLook, pointAt,
  type Appearance, type ClimbStop, type Move,
} from "@/lib/game/climb";

const LOOK_KEY = "ml_look";
const VIEW_H = 230; // visible window of the 360 × 1000 world (the svg keeps this aspect ratio, so nothing is cropped)
const DURATION: Record<Move, number> = { none: 0, short: 0.9, big: 1.4, leap: 1.8 };

function readLook(): Appearance {
  try {
    return parseLook(localStorage.getItem(LOOK_KEY));
  } catch {
    return DEFAULT_LOOK;
  }
}

/**
 * Signature visual: a small climber on a stylized Mount Royal staircase. Position is proportional to the ride's
 * score (see lib/game/climb.ts); displayed "steps" are gamified progress, not measured altitude.
 */
export function MountRoyalClimb({ stops, compact = false }: { stops: ClimbStop[]; compact?: boolean }) {
  const { t, locale } = useApp();
  const tc = t.climb;
  const reduce = useReducedMotion() ?? false;
  const [look, setLook] = useState<Appearance>(DEFAULT_LOOK);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate a client-only preference
    setLook(readLook());
  }, []);
  const saveLook = (l: Appearance) => {
    setLook(l);
    try {
      localStorage.setItem(LOOK_KEY, JSON.stringify(l));
    } catch {
      /* storage unavailable */
    }
  };

  const steps = climbSteps(stops);
  const frac = climbFraction(steps);
  const pos = pointAt(frac);
  const tier = bestTier(stops);
  const summit = frac >= 1;
  const lastIndex = stops.findLastIndex((s) => s !== null);
  const last = lastIndex >= 0 ? stops[lastIndex] : null;
  const move = moveFor(last);
  const camY = Math.min(WORLD.h - VIEW_H, Math.max(0, pos.y - VIEW_H * 0.62));

  // The newest answer drives the animation; a restored ride (reload, several stops at once) renders in place.
  const [seenIdx, setSeenIdx] = useState<number | null>(null);
  const [fresh, setFresh] = useState(false);
  if (seenIdx !== lastIndex) {
    setFresh(seenIdx !== null && lastIndex === seenIdx + 1);
    setSeenIdx(lastIndex);
  }
  const animateMove: Move = fresh ? move : "none";

  const dur = reduce ? 0 : DURATION[animateMove] || 0.6;
  const ease = [0.33, 1, 0.68, 1] as const;
  const stairPath = `M${STAIR.map((p) => p.join(",")).join("L")}`;
  const label = tc.aria(steps, SUMMIT_STEPS, tier ? TIER_LABELS[tier][locale] : tc.noTier);

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card" data-testid="climb" data-steps={steps} data-move={move}>
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{tc.title}</p>
          <p className="text-sm font-semibold tabular-nums" data-testid="climb-steps">
            {tc.steps(Math.min(steps, SUMMIT_STEPS), SUMMIT_STEPS)}
            {tier && (
              <span className="ml-2 rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: TIER_COLOR[tier], color: "oklch(0.18 0.03 262)" }}>
                {TIER_LABELS[tier][locale]}
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing((e) => !e)}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl border border-border hover:bg-muted"
          aria-expanded={editing}
          aria-label={tc.customize}
          data-testid="climb-customize"
        >
          <Palette className="size-4" aria-hidden />
        </button>
      </div>

      <div className="mx-4 mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <motion.div className="h-full rounded-full bg-line-green" initial={false} animate={{ width: `${frac * 100}%` }} transition={{ duration: reduce ? 0 : 0.8 }} />
      </div>

      {editing && <Customizer look={look} onChange={saveLook} />}

      <div className="mt-2 bg-[linear-gradient(#0d1530,#24345e)]">
      <svg
        viewBox={`0 0 ${WORLD.w} ${VIEW_H}`}
        className={`mx-auto block aspect-[360/230] w-full ${compact ? "max-w-sm" : "max-w-md"}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={label}
      >
        <defs>
          <linearGradient id="mr-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0d1530" />
            <stop offset="1" stopColor="#24345e" />
          </linearGradient>
          <linearGradient id="mr-hill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1e5a43" />
            <stop offset="1" stopColor="#123526" />
          </linearGradient>
        </defs>
        <rect width={WORLD.w} height={VIEW_H} fill="url(#mr-sky)" />
        {/* Far layer: stars and the downtown skyline seen from the lookout (slowest parallax). */}
        <motion.g initial={false} animate={{ y: -camY * 0.15 }} transition={{ duration: dur, ease }}>
          {[[30, 30], [90, 60], [150, 22], [220, 48], [300, 30], [330, 80], [60, 110]].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={1.2} fill="#fff" opacity={0.6} />
          ))}
          <Skyline y={150} />
        </motion.g>
        {/* Mid layer: distant tree line. */}
        <motion.g initial={false} animate={{ y: -camY * 0.5 }} transition={{ duration: dur, ease }}>
          <path d="M0 260 Q60 220 120 250 T240 240 T360 230 V600 H0Z" fill="#163f30" opacity={0.85} />
          {Array.from({ length: 9 }, (_, i) => <Tree key={i} x={20 + i * 40} y={250 + (i % 3) * 14} s={0.8} color="#1b4a37" />)}
        </motion.g>
        {/* World layer: the mountain, staircase, trees, lookout and climber (camera follows the climber). */}
        <motion.g initial={false} animate={{ y: -camY }} transition={{ duration: dur, ease }}>
          <path d="M-20 1000 L-20 260 Q60 150 180 110 Q300 150 380 260 L380 1000Z" fill="url(#mr-hill)" />
          <Lookout x={176} y={150} lit={summit} />
          <path d={stairPath} fill="none" stroke="#c9b48a" strokeWidth={14} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
          <path d={stairPath} fill="none" stroke="#8c7653" strokeWidth={14} strokeDasharray="2 6" strokeLinejoin="round" />
          {[[20, 900], [330, 820], [20, 700], [335, 600], [30, 490], [330, 390], [40, 300], [320, 200], [250, 160], [100, 190], [180, 980], [200, 520], [180, 700]].map(([x, y], i) => (
            <Tree key={i} x={x} y={y} s={1 + (i % 3) * 0.15} color={i % 2 ? "#2f8a5f" : "#26734f"} />
          ))}
          <motion.g
            initial={false}
            animate={
              animateMove === "leap" && !reduce
                ? { x: pos.x, y: [null, pos.y - 46, pos.y] }
                : { x: pos.x, y: pos.y }
            }
            transition={{ duration: dur, ease, times: animateMove === "leap" ? [0, 0.6, 1] : undefined }}
            data-testid="climber"
          >
            <Climber look={look} facing={pos.facing} walking={animateMove !== "none" && !reduce} duration={dur} />
          </motion.g>
          <AnimatePresence>
            {!reduce && (animateMove === "leap" || (summit && animateMove !== "none")) && (
              <Burst key={`b-${lastIndex}`} x={pos.x} y={pos.y - 20} delay={dur * 0.8} />
            )}
          </AnimatePresence>
        </motion.g>
      </svg>
      </div>
      <p className="sr-only" aria-live="polite">
        {label}
      </p>
      {summit && <p className="px-4 pb-3 pt-1 text-center text-sm font-bold text-line-yellow">{tc.summit}</p>}
      <p className="px-4 pb-3 text-[11px] text-muted-foreground">{tc.gamified}</p>
    </section>
  );
}

function Customizer({ look, onChange }: { look: Appearance; onChange: (l: Appearance) => void }) {
  const { t } = useApp();
  const tc = t.climb;
  const swatch = (on: boolean) => `size-9 rounded-full border-2 ${on ? "border-foreground" : "border-transparent"} outline-offset-2`;
  return (
    <div className="mx-4 mt-3 grid gap-3 rounded-xl border border-border p-3 text-sm" data-testid="climb-customizer">
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="mb-1 text-xs font-bold">{tc.skin}</legend>
        {SKINS.map((c, i) => (
          <button key={c} type="button" className={swatch(look.skin === i)} style={{ background: c }} aria-pressed={look.skin === i} aria-label={tc.skinN(i + 1)} onClick={() => onChange({ ...look, skin: i })} />
        ))}
      </fieldset>
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="mb-1 text-xs font-bold">{tc.jacket}</legend>
        {JACKETS.map((c, i) => (
          <button key={c} type="button" className={swatch(look.jacket === i)} style={{ background: c }} aria-pressed={look.jacket === i} aria-label={tc.jacketN(i + 1)} onClick={() => onChange({ ...look, jacket: i })} data-testid={`jacket-${i}`} />
        ))}
      </fieldset>
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="mb-1 text-xs font-bold">{tc.hat}</legend>
        {HATS.map((h) => (
          <button key={h} type="button" onClick={() => onChange({ ...look, hat: h })} aria-pressed={look.hat === h} className={`min-h-9 rounded-lg border px-3 text-xs font-semibold ${look.hat === h ? "border-foreground bg-muted" : "border-border"}`}>
            {tc.hats[h]}
          </button>
        ))}
      </fieldset>
    </div>
  );
}

/** Original character: round head, puffer jacket, optional tuque or cap. Drawn standing at (0,0) = feet. */
function Climber({ look, facing, walking, duration }: { look: Appearance; facing: 1 | -1; walking: boolean; duration: number }) {
  const skin = SKINS[look.skin];
  const jacket = JACKETS[look.jacket];
  const bob = walking ? { y: [0, -3, 0, -3, 0, -3, 0] } : { y: 0 };
  const leg = (dir: 1 | -1) => (walking ? { rotate: [0, 22 * dir, -22 * dir, 22 * dir, -22 * dir, 0] } : { rotate: 0 });
  return (
    <motion.g animate={bob} transition={{ duration, ease: "linear" }}>
      <g transform={`scale(${facing},1)`}>
        <ellipse cx={0} cy={1} rx={9} ry={2.5} fill="#000" opacity={0.25} />
        <motion.rect x={-4} y={-11} width={3.5} height={11} rx={1.5} fill="#2a2f45" style={{ originX: "50%", originY: "0%" }} animate={leg(1)} transition={{ duration }} />
        <motion.rect x={0.5} y={-11} width={3.5} height={11} rx={1.5} fill="#2a2f45" style={{ originX: "50%", originY: "0%" }} animate={leg(-1)} transition={{ duration }} />
        <rect x={-7} y={-25} width={14} height={16} rx={6} fill={jacket} />
        <rect x={-1} y={-24} width={2} height={13} fill="#000" opacity={0.18} />
        <rect x={-9} y={-23} width={4} height={10} rx={2} fill={jacket} />
        <rect x={6} y={-23} width={4} height={10} rx={2} fill={jacket} transform="rotate(-20 8 -23)" />
        <circle cx={0} cy={-31} r={7} fill={skin} />
        <circle cx={3} cy={-32} r={1} fill="#1b1b1b" />
        {look.hat === "tuque" && (
          <g>
            <path d="M-7.5 -32 Q0 -45 7.5 -32Z" fill={jacket} />
            <rect x={-8} y={-33.5} width={16} height={3} rx={1.5} fill="#f2efe6" />
            <circle cx={0} cy={-41} r={2.4} fill="#f2efe6" />
          </g>
        )}
        {look.hat === "cap" && (
          <g>
            <path d="M-7 -33 Q0 -42 7 -33Z" fill="#1d2433" />
            <rect x={3} y={-34} width={8} height={2} rx={1} fill="#1d2433" />
          </g>
        )}
        {look.hat === "none" && <path d="M-7 -33 Q0 -40 7 -33 Q2 -36 -7 -33Z" fill="#3b2a1e" />}
      </g>
    </motion.g>
  );
}

function Tree({ x, y, s, color }: { x: number; y: number; s: number; color: string }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <rect x={-1.5} y={-4} width={3} height={6} fill="#3b2a1e" />
      <path d="M0 -26 L10 -4 H-10Z" fill={color} />
      <path d="M0 -34 L8 -16 H-8Z" fill={color} />
    </g>
  );
}

/** Stylized lookout pavilion with a terrace railing (not a reproduction of the real chalet). */
function Lookout({ x, y, lit }: { x: number; y: number; lit: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={-46} y={-6} width={92} height={8} rx={2} fill="#9c8a6a" />
      {Array.from({ length: 10 }, (_, i) => <rect key={i} x={-44 + i * 9.6} y={-14} width={1.6} height={8} fill="#d8ccb0" />)}
      <rect x={-46} y={-15} width={92} height={2} fill="#d8ccb0" />
      <rect x={-24} y={-40} width={48} height={26} fill="#c4b08a" />
      <path d="M-30 -40 L0 -58 L30 -40Z" fill="#7a3b2e" />
      {[-16, -4, 8].map((wx) => <rect key={wx} x={wx} y={-34} width={8} height={10} rx={1} fill={lit ? "#ffd166" : "#4a5470"} />)}
    </g>
  );
}

function Skyline({ y }: { y: number }) {
  // Generic towers with warm window lights: an evocation of a downtown skyline, not specific buildings.
  const towers: [number, number, number][] = [[18, 40, 14], [36, 62, 16], [56, 48, 12], [72, 88, 18], [94, 70, 14], [112, 104, 20], [136, 76, 16], [156, 94, 14], [174, 58, 18], [196, 82, 16], [216, 66, 14], [234, 98, 18], [256, 52, 16], [276, 74, 14], [294, 44, 18], [316, 60, 16], [336, 36, 18]];
  return (
    <g>
      {towers.map(([x, h, w], i) => (
        <g key={i}>
          <rect x={x} y={y - h} width={w} height={h} fill="#1a2547" />
          {Array.from({ length: Math.floor(h / 12) }, (_, r) => (
            <rect key={r} x={x + 3} y={y - h + 5 + r * 12} width={w - 6} height={2} fill="#ffb547" opacity={(i + r) % 3 ? 0.5 : 0.9} />
          ))}
        </g>
      ))}
      <rect x={0} y={y} width={WORLD.w} height={6} fill="#1a2547" />
    </g>
  );
}

function Burst({ x, y, delay }: { x: number; y: number; delay: number }) {
  const rays = Array.from({ length: 10 }, (_, i) => (i / 10) * Math.PI * 2);
  const colors = ["#ffd166", "#4cc38a", "#5ec8ff", "#ff7eb6"];
  return (
    <g transform={`translate(${x} ${y})`}>
      {rays.map((a, i) => (
        <motion.circle
          key={i}
          r={2.5}
          fill={colors[i % colors.length]}
          initial={{ cx: 0, cy: 0, opacity: 0 }}
          animate={{ cx: Math.cos(a) * 28, cy: Math.sin(a) * 28, opacity: [0, 1, 0] }}
          transition={{ duration: 0.9, delay }}
        />
      ))}
    </g>
  );
}
