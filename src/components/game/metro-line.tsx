"use client";

import { motion } from "motion/react";
import type { Tier } from "@/lib/game/types";
import { TIER_COLOR } from "@/lib/client/fx";

export type StopState = { status: "correct" | "incorrect" | "expired"; tier: Tier | null; score: number } | null;

/** Seven métro stops: a progress bar that reads like a line map. */
export function MetroLine({ stops, current, label }: { stops: StopState[]; current: number; label: string }) {
  const n = stops.length;
  const progress = n > 1 ? Math.min(current, n - 1) / (n - 1) : 0;
  return (
    <div className="relative px-3 py-3" role="progressbar" aria-valuemin={1} aria-valuemax={n} aria-valuenow={Math.min(current + 1, n)} aria-label={label}>
      <div className="absolute inset-x-6 top-1/2 h-2 -translate-y-1/2 rounded-full bg-muted" />
      <motion.div
        className="absolute left-6 top-1/2 h-2 -translate-y-1/2 rounded-full bg-line-orange"
        initial={false}
        animate={{ width: `calc((100% - 3rem) * ${progress})` }}
        transition={{ type: "spring", stiffness: 120, damping: 20 }}
      />
      <ol className="relative flex justify-between">
        {stops.map((s, i) => {
          const isCurrent = i === current;
          const color = s ? (s.status === "correct" && s.tier ? TIER_COLOR[s.tier] : "var(--destructive)") : undefined;
          return (
            <li key={i} className="relative grid size-6 place-items-center">
              {isCurrent && (
                <motion.span
                  className="absolute inset-0 rounded-full bg-line-orange/40"
                  animate={{ scale: [1, 1.9], opacity: [0.7, 0] }}
                  transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
                />
              )}
              <motion.span
                className="relative grid size-6 place-items-center rounded-full border-[3px] text-[10px] font-bold"
                initial={false}
                animate={{
                  backgroundColor: color ?? (isCurrent ? "var(--tile)" : "var(--background)"),
                  borderColor: color ?? (i < current || isCurrent ? "var(--line-orange)" : "var(--border)"),
                  scale: isCurrent ? 1.15 : 1,
                }}
                transition={{ type: "spring", stiffness: 300, damping: 18 }}
                style={{ color: "oklch(0.2 0.03 262)" }}
              >
                {s ? (s.status === "correct" ? "" : "×") : ""}
                <span className="sr-only">
                  {i + 1}: {s ? `${s.status} ${s.score}` : isCurrent ? "current" : "upcoming"}
                </span>
              </motion.span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
