"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ArrowRight, Flame } from "lucide-react";
import { useApp } from "@/components/providers";
import { Wordmark } from "@/components/site-header";
import { MountainBackdrop } from "@/components/mountain-backdrop";
import { readStreak } from "@/lib/client/fx";
import { CATEGORY_LABELS } from "@/lib/i18n/dict";
import type { CategoryId } from "@/lib/game/types";

const LINES = ["var(--line-green)", "var(--line-orange)", "var(--line-yellow)", "var(--line-blue)"];

export function HomeView({
  questionCount,
  today,
  categories,
}: {
  questionCount: number;
  today: string;
  categories: { id: CategoryId; count: number }[];
}) {
  const { t, locale } = useApp();
  const [streak, setStreak] = useState(0);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only storage read
  useEffect(() => setStreak(readStreak(today)), [today]);

  return (
    <div className="space-y-8">
      <section className="pt-4 text-center">
        <motion.h1 initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="text-5xl sm:text-6xl">
          <Wordmark />
        </motion.h1>
        <p className="mx-auto mt-4 max-w-md text-lg text-muted-foreground">{t.tagline}</p>
        <div className="mx-auto mt-6 flex max-w-xs items-center justify-between" aria-hidden>
          {Array.from({ length: 7 }, (_, i) => (
            <motion.span
              key={i}
              className="size-4 rounded-full border-[3px] border-line-orange bg-background"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.15 + i * 0.07, type: "spring", stiffness: 400, damping: 15 }}
            />
          ))}
        </div>
        <div className="mx-auto -mt-2.5 h-1 max-w-[19rem] rounded-full bg-line-orange/60" aria-hidden />
        <MountainBackdrop className="-mb-6 mt-2 opacity-90" />
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <ModeCard href="/play/daily" color={LINES[1]} title={t.home.dailyTitle} body={t.home.dailyBody} cta={t.home.play} testId="play-daily">
          <p className="mt-1 font-mono text-xs text-muted-foreground">{today}</p>
          {streak > 0 && (
            <p className="mt-2 inline-flex items-center gap-1 text-sm font-bold text-line-orange">
              <Flame className="size-4" aria-hidden />
              {t.home.streak(streak)}
            </p>
          )}
        </ModeCard>
        <ModeCard href="/play/unlimited" color={LINES[3]} title={t.home.unlimitedTitle} body={t.home.unlimitedBody} cta={t.home.play} testId="play-unlimited" />
      </div>

      {categories.length > 0 && (
        <section className="space-y-2" aria-labelledby="lines-title">
          <p id="lines-title" className="text-sm font-bold text-muted-foreground">
            {t.home.pickLine}
          </p>
          <ul className="flex flex-wrap gap-2">
            {categories.map((c, i) => (
              <li key={c.id}>
                <Link
                  href={`/play/unlimited?category=${c.id}`}
                  className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-sm font-bold hover:bg-muted"
                  data-testid={`category-${c.id}`}
                >
                  <span className="size-2.5 rounded-full" style={{ background: LINES[i % LINES.length] }} aria-hidden />
                  {CATEGORY_LABELS[c.id][locale]}
                  <span className="font-normal text-muted-foreground">{c.count}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-center text-sm text-muted-foreground">
        {t.home.seed(questionCount)} ·{" "}
        <Link href="/how-to-play" className="underline underline-offset-4 hover:text-foreground">
          {t.nav.how}
        </Link>
      </p>
    </div>
  );
}

function ModeCard({
  href,
  color,
  title,
  body,
  cta,
  testId,
  children,
}: {
  href: string;
  color: string;
  title: string;
  body: string;
  cta: string;
  testId: string;
  children?: React.ReactNode;
}) {
  return (
    <motion.div whileHover={{ y: -3 }} whileTap={{ scale: 0.98 }}>
      <Link
        href={href}
        data-testid={testId}
        className="group block overflow-hidden rounded-2xl border border-border bg-card outline-none focus-visible:ring-3 focus-visible:ring-ring"
      >
        <div className="h-2" style={{ background: color }} />
        <div className="p-5">
          <h2 className="text-2xl font-extrabold">{title}</h2>
          <p className="mt-1 text-muted-foreground">{body}</p>
          {children}
          <span className="mt-4 inline-flex items-center gap-1.5 rounded-full px-4 py-2 font-bold" style={{ background: color, color: "oklch(0.18 0.03 262)" }}>
            {cta}
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
          </span>
        </div>
      </Link>
    </motion.div>
  );
}
