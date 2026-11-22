"use client";

import type { Tier } from "@/lib/game/types";

let ctx: AudioContext | null = null;

/** Tiny synthesized chimes (no audio assets). Only called when the player enabled sound. */
export function chime(kind: "correct" | "wrong" | "tick" | "legend") {
  try {
    ctx ??= new AudioContext();
    const notes = { correct: [660, 880], wrong: [220, 165], tick: [1200], legend: [523, 659, 784, 1047] }[kind];
    notes.forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      const t0 = ctx!.currentTime + i * 0.09;
      o.type = kind === "wrong" ? "triangle" : "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(kind === "tick" ? 0.04 : 0.12, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + (kind === "tick" ? 0.06 : 0.28));
      o.connect(g).connect(ctx!.destination);
      o.start(t0);
      o.stop(t0 + 0.3);
    });
  } catch {
    /* audio unavailable */
  }
}

export const TIER_COLOR: Record<Tier, string> = {
  legend: "var(--line-yellow)",
  gem: "var(--line-blue)",
  expert: "var(--line-green)",
  regular: "var(--line-orange)",
  tourist: "var(--line-grey)",
};

export const TIER_EMOJI: Record<Tier | "miss", string> = {
  legend: "🟨",
  gem: "🟦",
  expert: "🟩",
  regular: "🟧",
  tourist: "⬜",
  miss: "⬛",
};

/** Per-device daily streak (server-side streaks arrive with accounts). */
export function recordDailyStreak(dateKey: string): number {
  try {
    const raw = localStorage.getItem("ml_streak");
    const s = raw ? (JSON.parse(raw) as { last: string; n: number }) : { last: "", n: 0 };
    if (s.last === dateKey) return s.n;
    const prev = new Date(`${dateKey}T12:00:00Z`);
    prev.setUTCDate(prev.getUTCDate() - 1);
    const n = s.last === prev.toISOString().slice(0, 10) ? s.n + 1 : 1;
    localStorage.setItem("ml_streak", JSON.stringify({ last: dateKey, n }));
    return n;
  } catch {
    return 0;
  }
}

export function readStreak(today: string): number {
  try {
    const raw = localStorage.getItem("ml_streak");
    if (!raw) return 0;
    const s = JSON.parse(raw) as { last: string; n: number };
    const prev = new Date(`${today}T12:00:00Z`);
    prev.setUTCDate(prev.getUTCDate() - 1);
    return s.last === today || s.last === prev.toISOString().slice(0, 10) ? s.n : 0;
  } catch {
    return 0;
  }
}
