"use client";

import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useReducedMotion } from "motion/react";
import { ChevronLeft, Crosshair, Palette, Settings2 } from "lucide-react";
import { useApp } from "@/components/providers";
import { TIER_LABELS } from "@/lib/i18n/dict";
import { TIER_COLOR } from "@/lib/client/fx";
import { useLook } from "@/lib/client/account";
import { SUMMIT_STEPS, bestTier, climbFraction, climbSteps, moveFor, type ClimbStop } from "@/lib/game/climb";
import { LookEditor } from "../look-editor";
import type { Quality } from "./climb-scene";

// The 3D scene (three.js + R3F) is its own chunk, loaded only on game pages and never on the server.
const ClimbScene = dynamic(() => import("./climb-scene"), { ssr: false, loading: () => null });

export type GfxPref = "auto" | "low" | "high" | "2d";
const GFX_KEY = "ml_gfx";
/** Opt-in frame-rate readout for measuring real devices: `?fps=1` turns it on (remembered), `?fps=0` off. */
const FPS_KEY = "ml_fps";

function fpsOverlayWanted(): boolean {
  const q = new URLSearchParams(location.search).get("fps");
  try {
    if (q === "1") localStorage.setItem(FPS_KEY, "1");
    if (q === "0") localStorage.removeItem(FPS_KEY);
    return localStorage.getItem(FPS_KEY) === "1";
  } catch {
    return q === "1";
  }
}

/** The GPU's name, when the browser exposes it (handy for telling phones apart in measurements). */
function gpuName(): string | null {
  try {
    const gl = document.createElement("canvas").getContext("webgl2") ?? document.createElement("canvas").getContext("webgl");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    // "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)" → "Apple M4"
    return name.replace(/^ANGLE \((.*)\)$/, "$1").replace(/^.*Renderer: /, "").replace(/, Unspecified Version$/, "");
  } catch {
    return null;
  }
}

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") || c.getContext("webgl")) as WebGLRenderingContext | null;
    // Release the probe right away: browsers cap live contexts and drop the oldest (which could be the scene's).
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

/** Auto quality: phones, coarse pointers and small CPUs get the light scene (no shadows, lower resolution). */
function autoQuality(): Quality {
  const coarse = matchMedia("(pointer: coarse)").matches;
  const small = Math.min(innerWidth, innerHeight) < 600;
  const cores = navigator.hardwareConcurrency ?? 8;
  return coarse || small || cores <= 4 ? "low" : "high";
}

/** Graphics preference (per device) plus what this device can actually do. `mode` is null until known (SSR). */
export function useGfx() {
  const [pref, setPrefState] = useState<GfxPref>("auto");
  const [env, setEnv] = useState<{ webgl: boolean; auto: Quality } | null>(null);
  const [failed, setFailed] = useState(false);
  /** Bumped to rebuild the canvas once after a context loss before giving up on 3D. */
  const [attempt, setAttempt] = useState(0);
  const lastLoss = useRef(0);
  const [degraded, setDegraded] = useState(false);
  useEffect(() => {
    let saved: GfxPref = "auto";
    try {
      const v = localStorage.getItem(GFX_KEY);
      if (v === "low" || v === "high" || v === "2d" || v === "auto") saved = v;
    } catch {}
    // Reading device capabilities is only possible after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrefState(saved);
    setEnv({ webgl: hasWebGL(), auto: autoQuality() });
  }, []);
  const setPref = useCallback((p: GfxPref) => {
    setPrefState(p);
    setFailed(false);
    setDegraded(false);
    try {
      localStorage.setItem(GFX_KEY, p);
    } catch {}
  }, []);
  const fail = useCallback(() => setFailed(true), []);
  /** A lost context gets one rebuild; a second loss within 20 s switches to the simple view. */
  const lost = useCallback(() => {
    const now = performance.now();
    if (now - lastLoss.current < 20_000) setFailed(true);
    else setAttempt((a) => a + 1);
    lastLoss.current = now;
  }, []);
  /** Auto mode only: measured frame rate during a climb was low, so drop to the light scene. */
  const degrade = useCallback(() => {
    if (pref === "auto") setDegraded(true);
  }, [pref]);
  const mode: "3d" | "2d" | null = env === null ? null : !env.webgl || failed || pref === "2d" ? "2d" : "3d";
  const quality: Quality = pref === "low" || pref === "high" ? pref : degraded ? "low" : (env?.auto ?? "low");
  return {
    pref,
    setPref,
    mode,
    quality,
    noWebgl: env !== null && (!env.webgl || failed),
    attempt,
    fail,
    lost,
    degrade,
  };
}

class SceneBoundary extends Component<{ onError: () => void; children: ReactNode }, { broken: boolean }> {
  state = { broken: false };
  static getDerivedStateFromError() {
    return { broken: true };
  }
  componentDidCatch(e: unknown) {
    console.error("[climb] 3D scene failed, using the simple view", e);
    this.props.onError();
  }
  render() {
    return this.state.broken ? null : this.props.children;
  }
}

/**
 * Full-viewport 3D backdrop. `inset` is the screen area covered by the game panel (left column on desktop,
 * bottom sheet on phones), so the camera frames the climber in the part of the screen that stays visible.
 */
export function ClimbBackdrop({
  gfx,
  stops,
  liveIndex = -1,
  finished,
  intro,
  resetKey,
  inset,
}: {
  gfx: ReturnType<typeof useGfx>;
  stops: ClimbStop[];
  /** Index of the stop answered live in this tab; only that one animates (restored history stands still). */
  liveIndex?: number;
  finished: boolean;
  intro: boolean;
  resetKey: number;
  inset: { left: number; bottom: number; top: number };
}) {
  const { t } = useApp();
  const { look } = useLook();
  const reduce = useReducedMotion() ?? false;
  const steps = climbSteps(stops);
  const lastIndex = stops.findLastIndex((s) => s !== null);
  const last = lastIndex >= 0 ? stops[lastIndex] : null;
  // Frame-rate telemetry goes straight to data attributes (for QA/tests), never through React state: re-rendering
  // the scene tree mid-climb would cost frames right while they're being measured.
  const stage = useRef<HTMLDivElement>(null);
  const lowFrames = useRef(0);
  const fpsOut = useRef<HTMLSpanElement>(null);
  const minFps = useRef(Infinity);
  const [overlay, setOverlay] = useState<{ gpu: string | null } | null>(null);
  useEffect(() => {
    // URL and storage are only readable after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (fpsOverlayWanted()) setOverlay({ gpu: gpuName() });
  }, []);
  const { degrade, lost } = gfx;
  const onContextLost = useCallback(() => {
    console.warn("[climb] WebGL context lost");
    lost();
  }, [lost]);
  const onStats = useCallback(
    (s: { fps: number; calls: number }) => {
      const el = stage.current;
      if (el) {
        el.dataset.fps = String(Math.round(s.fps));
        el.dataset.calls = String(s.calls);
      }
      if (fpsOut.current) {
        const fps = Math.round(s.fps);
        minFps.current = Math.min(minFps.current, fps);
        fpsOut.current.textContent = `${fps} fps · min ${minFps.current} · ${s.calls} calls`;
      }
      lowFrames.current = s.fps < 28 ? lowFrames.current + 1 : 0;
      if (lowFrames.current >= 3) degrade();
    },
    [degrade],
  );

  return (
    <div
      className="absolute inset-0 bg-[radial-gradient(120%_80%_at_70%_0%,#2a3d78_0%,#121b38_55%,#0b1230_100%)]"
      data-testid="climb-stage"
      data-mode={gfx.mode ?? "pending"}
      data-quality={gfx.quality}
      ref={stage}
    >
      {gfx.mode === "3d" && (
        <SceneBoundary onError={gfx.fail}>
          <div className="absolute inset-0">
            <ClimbScene
              key={`${gfx.quality}:${gfx.attempt}`}
              steps={steps}
              lastIndex={lastIndex}
              animate={liveIndex === lastIndex}
              lastMove={moveFor(last)}
              lastMissed={!!last && last.status !== "correct"}
              finished={finished}
              intro={intro}
              look={look}
              quality={gfx.quality}
              reduceMotion={reduce}
              resetKey={resetKey}
              inset={inset}
              onContextLost={onContextLost}
              onStats={onStats}
            />
          </div>
        </SceneBoundary>
      )}
      {gfx.mode === null && <p className="sr-only">{t.scene.loading}</p>}
      {overlay &&
        createPortal(
          <div
            // Top-left, over the logo: the one spot that hides no game content on either layout.
            className="pointer-events-none fixed left-1 top-1 z-[1000] max-w-[70vw] rounded-md bg-black/80 px-1.5 py-0.5 font-mono text-[10px] leading-tight text-white"
            data-testid="fps-overlay"
            aria-hidden
          >
            <span ref={fpsOut} className="block" data-testid="fps-value">
              {gfx.mode === "3d" ? "fps: climb to measure" : "fps: n/a"}
            </span>
            <span className="block truncate text-white/70">
              {gfx.mode ?? "…"} · {gfx.quality}
              {gfx.pref === "auto" ? " (auto)" : ""}
              {overlay.gpu ? ` · ${overlay.gpu}` : ""}
            </span>
          </div>,
          // On <body>: the stage is its own stacking context under the site header, which would cover it.
          document.body,
      )}
    </div>
  );
}

/** Climb readout over the scene: steps, best tier, customizer. Carries the scene's text description. */
export function ClimbHud({ stops }: { stops: ClimbStop[] }) {
  const { t, locale } = useApp();
  const tc = t.climb;
  const { look, allowed, signedIn, save } = useLook();
  const [editing, setEditing] = useState(false);
  const steps = climbSteps(stops);
  const frac = climbFraction(steps);
  const tier = bestTier(stops);
  const last = stops.findLast((s) => s !== null) ?? null;
  const label = tc.aria(steps, SUMMIT_STEPS, tier ? TIER_LABELS[tier][locale] : tc.noTier);
  return (
    <section className="pointer-events-auto relative" data-testid="climb" data-steps={steps} data-move={moveFor(last)} aria-label={tc.title}>
      <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-background/70 py-1.5 pl-3 pr-1.5 backdrop-blur-md">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">{tc.title}</p>
          <p className="text-sm font-semibold tabular-nums" data-testid="climb-steps">
            {tc.steps(Math.min(steps, SUMMIT_STEPS), SUMMIT_STEPS)}
            {tier && (
              <span className="ml-2 rounded-full px-2 py-0.5 text-[11px] font-bold" style={{ background: TIER_COLOR[tier], color: "oklch(0.18 0.03 262)" }}>
                {TIER_LABELS[tier][locale]}
              </span>
            )}
          </p>
          <div className="mt-1 h-1 w-28 overflow-hidden rounded-full bg-muted sm:w-36" role="img" aria-label={label}>
            <div className="h-full rounded-full bg-line-green transition-[width] duration-700" style={{ width: `${frac * 100}%` }} />
          </div>
        </div>
        <button
          type="button"
          onClick={() => setEditing((e) => !e)}
          className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-card/70 transition-colors hover:bg-muted active:scale-95"
          aria-expanded={editing}
          aria-label={tc.customize}
          data-testid="climb-customize"
        >
          <Palette className="size-4" aria-hidden />
        </button>
      </div>
      {editing && (
        <div
          className="absolute right-0 top-full z-20 mt-2 max-h-[55dvh] w-[min(22rem,calc(100vw-2rem))] space-y-2 overflow-y-auto rounded-2xl border border-border bg-background/95 p-3 shadow-xl backdrop-blur"
          data-testid="climb-customizer"
        >
          <LookEditor look={look} allowed={allowed} onChange={(l) => void save(l)} parts={signedIn ? undefined : ["skin", "jacket", "hat"]} />
          <Link href="/account" className="inline-block text-xs font-semibold underline">
            {signedIn ? tc.moreOnAccount : tc.moreWithAccount}
          </Link>
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {label}
      </p>
      <p className="sr-only">{tc.gamified}</p>
      {frac >= 1 && (
        <p className="mt-2 rounded-xl bg-background/70 px-3 py-1.5 text-center text-sm font-bold text-line-yellow backdrop-blur" role="status">
          {t.scene.summit}
        </p>
      )}
    </section>
  );
}

/** Display settings: 3D quality, simple (2D) view, camera reset. */
export function SceneSettings({ gfx, onResetCamera }: { gfx: ReturnType<typeof useGfx>; onResetCamera: () => void }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const click = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    addEventListener("keydown", key);
    addEventListener("mousedown", click);
    return () => {
      removeEventListener("keydown", key);
      removeEventListener("mousedown", click);
    };
  }, [open]);
  const opts: [GfxPref, string][] = [
    ["auto", t.scene.qualityAuto],
    ["low", t.scene.qualityLow],
    ["high", t.scene.qualityHigh],
    ["2d", t.scene.scene2d],
  ];
  return (
    <div ref={ref} className="pointer-events-auto relative flex gap-1.5">
      {gfx.mode === "3d" && (
        <button
          type="button"
          onClick={onResetCamera}
          className="grid size-10 place-items-center rounded-xl border border-white/10 bg-background/70 backdrop-blur-md hover:bg-muted"
          aria-label={t.scene.resetCamera}
          title={t.scene.resetCamera}
          data-testid="reset-camera"
        >
          <Crosshair className="size-4" aria-hidden />
        </button>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="grid size-10 place-items-center rounded-xl border border-white/10 bg-background/70 backdrop-blur-md hover:bg-muted"
        aria-expanded={open}
        aria-label={t.scene.settings}
        title={t.scene.settings}
        data-testid="scene-settings"
      >
        <Settings2 className="size-4" aria-hidden />
      </button>
      {open && (
        <fieldset className="absolute right-0 top-full z-30 mt-2 w-56 space-y-1 rounded-2xl border border-border bg-background/95 p-3 text-sm shadow-xl backdrop-blur">
          <legend className="sr-only">{t.scene.quality}</legend>
          <p className="mb-1 text-xs font-bold uppercase tracking-wider text-muted-foreground" aria-hidden>
            {t.scene.quality}
          </p>
          {opts.map(([v, label]) => (
            <label key={v} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-2 hover:bg-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
              <input type="radio" name="gfx" className="accent-[var(--line-green)]" checked={gfx.pref === v} onChange={() => gfx.setPref(v)} data-testid={`gfx-${v}`} />
              {label}
            </label>
          ))}
          {gfx.noWebgl && <p className="pt-1 text-xs text-muted-foreground">{t.scene.noWebgl}</p>}
        </fieldset>
      )}
    </div>
  );
}

export function LeaveButton() {
  const { t } = useApp();
  return (
    <Link
      href="/"
      className="pointer-events-auto grid size-10 place-items-center rounded-xl border border-white/10 bg-background/70 backdrop-blur-md hover:bg-muted"
      aria-label={t.scene.back}
      title={t.scene.back}
      data-testid="leave-game"
    >
      <ChevronLeft className="size-5" aria-hidden />
    </Link>
  );
}
