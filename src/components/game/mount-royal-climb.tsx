"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Palette } from "lucide-react";
import { useApp } from "@/components/providers";
import { TIER_LABELS } from "@/lib/i18n/dict";
import { TIER_COLOR } from "@/lib/client/fx";
import { STAIR, SUMMIT_STEPS, WORLD, bestTier, climbFraction, climbSteps, moveFor, pointAt, type ClimbStop, type Move } from "@/lib/game/climb";
import { useLook } from "@/lib/client/account";
import { ClimberFigure } from "./climber-figure";
import { LookEditor } from "./look-editor";

// Visible window of the 360 × 1000 world. The svg keeps this aspect (meet) so the climber is never cropped; the
// backdrop layers extend past both sides so wider screens see more scenery instead of letterbox bars.
const VIEW_H = 230;
const VIEW_H_COMPACT = 150;
const BLEED = 420;
const DURATION: Record<Move, number> = { none: 0, short: 0.9, big: 1.4, leap: 1.8 };

/**
 * Signature visual: a small climber on a stylized Mount Royal staircase. Position is proportional to the ride's
 * score (see lib/game/climb.ts); displayed "steps" are gamified progress, not measured altitude.
 */
export function MountRoyalClimb({ stops, compact = false }: { stops: ClimbStop[]; compact?: boolean }) {
  const { t, locale } = useApp();
  const tc = t.climb;
  const reduce = useReducedMotion() ?? false;
  const { look, allowed, signedIn, save } = useLook();
  const [editing, setEditing] = useState(false);

  const steps = climbSteps(stops);
  const frac = climbFraction(steps);
  const pos = pointAt(frac);
  const tier = bestTier(stops);
  const summit = frac >= 1;
  const lastIndex = stops.findLastIndex((s) => s !== null);
  const last = lastIndex >= 0 ? stops[lastIndex] : null;
  const move = moveFor(last);
  const viewH = compact ? VIEW_H_COMPACT : VIEW_H;
  const camY = Math.min(WORLD.h - viewH, Math.max(0, pos.y - viewH * (compact ? 0.78 : 0.62)));

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

  const headerBar = (
    <>
      <div className={`flex items-center justify-between gap-2 px-4 ${compact ? "pt-2" : "pt-3"}`}>
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
          className={`inline-flex shrink-0 items-center justify-center rounded-xl border border-border transition-colors hover:bg-muted active:scale-95 ${compact ? "size-10 bg-card/70 backdrop-blur" : "size-11"}`}
          aria-expanded={editing}
          aria-label={tc.customize}
          data-testid="climb-customize"
        >
          <Palette className="size-4" aria-hidden />
        </button>
      </div>

      <div className="mx-4 mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <motion.div className="h-full rounded-full bg-line-green" initial={false} animate={{ width: `${frac * 100}%` }} transition={{ duration: reduce ? 0 : 0.8 }} />
      </div>

    </>
  );
  const scene = (
      <div className={compact ? "bg-[#0d1530]" : "mt-2 bg-[#0d1530]"}>
      <svg
        viewBox={`0 0 ${WORLD.w} ${viewH}`}
        className={`block w-full ${compact ? "h-36" : "aspect-[360/230] max-h-80"}`}
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
        <rect x={-BLEED} width={WORLD.w + BLEED * 2} height={viewH} fill="url(#mr-sky)" />
        {/* Far layer: stars and the downtown skyline seen from the lookout (slowest parallax). */}
        <motion.g initial={false} animate={{ y: -camY * 0.15 }} transition={{ duration: dur, ease }}>
          {[-1, 0, 1].flatMap((k) =>
            [[30, 30], [90, 60], [150, 22], [220, 48], [300, 30], [330, 80], [60, 110]].map(([x, y], i) => (
              <circle key={`${k}-${i}`} cx={x + k * WORLD.w} cy={y} r={1.2} fill="#fff" opacity={0.6} />
            )),
          )}
          {[-1, 0, 1].map((k) => (
            <g key={k} transform={`translate(${k * WORLD.w} 0)`} opacity={k ? 0.8 : 1}>
              <Skyline y={150} />
            </g>
          ))}
        </motion.g>
        {/* Mid layer: distant tree line. */}
        <motion.g initial={false} animate={{ y: -camY * 0.5 }} transition={{ duration: dur, ease }}>
          <path d={`M${-BLEED} 250 Q60 220 120 250 T240 240 T360 230 T${WORLD.w + BLEED} 245 V600 H${-BLEED}Z`} fill="#163f30" opacity={0.85} />
          {Array.from({ length: 29 }, (_, i) => <Tree key={i} x={-380 + i * 40} y={250 + (i % 3) * 14} s={0.8} color="#1b4a37" />)}
        </motion.g>
        {/* World layer: the mountain, staircase, trees, lookout and climber (camera follows the climber). */}
        <motion.g initial={false} animate={{ y: -camY }} transition={{ duration: dur, ease }}>
          <path d={`M${-BLEED} 1000 L${-BLEED} 420 Q-60 300 60 190 Q120 130 180 110 Q240 130 300 190 Q420 300 ${WORLD.w + BLEED} 420 L${WORLD.w + BLEED} 1000Z`} fill="url(#mr-hill)" />
          {[[-60, 480], [-140, 620], [-90, 800], [420, 470], [500, 640], [440, 860], [-30, 360], [390, 340]].map(([x, y], i) => (
            <Tree key={`side-${i}`} x={x} y={y} s={1.1} color={i % 2 ? "#2f8a5f" : "#26734f"} />
          ))}
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
            <ClimberFigure look={look} facing={pos.facing} walking={animateMove !== "none" && !reduce} duration={dur} />
          </motion.g>
          <AnimatePresence>
            {!reduce && (animateMove === "leap" || (summit && animateMove !== "none")) && (
              <Burst key={`b-${lastIndex}`} x={pos.x} y={pos.y - 20} delay={dur * 0.8} />
            )}
          </AnimatePresence>
        </motion.g>
      </svg>
      </div>
  );

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card" data-testid="climb" data-steps={steps} data-move={move}>
      {compact ? (
        // In-game: title and progress float over the night sky so the question stays on the first screen.
        <div className="relative">
          {scene}
          <div className="absolute inset-x-0 top-0 bg-[linear-gradient(#0d1530ee,#0d153099_70%,transparent)] pb-3">{headerBar}</div>
        </div>
      ) : (
        headerBar
      )}
      {editing && (
        <div className="mx-4 mt-3 space-y-2 rounded-xl border border-border p-3" data-testid="climb-customizer">
          <LookEditor look={look} allowed={allowed} onChange={(l) => void save(l)} parts={signedIn ? undefined : ["skin", "jacket", "hat"]} />
          <Link href="/account" className="inline-block text-xs font-semibold underline">
            {signedIn ? tc.moreOnAccount : tc.moreWithAccount}
          </Link>
        </div>
      )}

      {!compact && scene}
      <p className="sr-only" aria-live="polite">
        {label}
      </p>
      {summit && <p className="px-4 pb-3 pt-1 text-center text-sm font-bold text-line-yellow">{tc.summit}</p>}
      {compact ? <p className="sr-only">{tc.gamified}</p> : <p className="px-4 pb-3 text-[11px] text-muted-foreground">{tc.gamified}</p>}
    </section>
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
