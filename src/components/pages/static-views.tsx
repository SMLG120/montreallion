"use client";

import { useApp } from "@/components/providers";
import { TIER_COLOR } from "@/lib/client/fx";
import { TIER_LABELS } from "@/lib/i18n/dict";
import type { Tier } from "@/lib/game/types";

const TIER_RANGES: [Tier, string][] = [
  ["legend", "90–100"],
  ["gem", "75–89"],
  ["expert", "55–74"],
  ["regular", "35–54"],
  ["tourist", "10–34"],
];

export function HowToPlayView() {
  const { t, locale } = useApp();
  return (
    <article className="space-y-8">
      <h1 className="text-4xl font-extrabold">{t.how.title}</h1>
      <ol className="space-y-3">
        {t.how.steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-full border-[3px] border-line-orange font-heading text-xs font-extrabold">{i + 1}</span>
            <p className="pt-0.5">{s}</p>
          </li>
        ))}
      </ol>
      <section className="space-y-3">
        <h2 className="text-2xl font-extrabold">{t.how.tiersTitle}</h2>
        <ul className="overflow-hidden rounded-xl border border-border">
          {TIER_RANGES.map(([tier, range]) => (
            <li key={tier} className="flex items-center gap-3 border-b border-border bg-card px-4 py-3 last:border-0">
              <span className="size-4 rounded-full" style={{ background: TIER_COLOR[tier] }} aria-hidden />
              <span className="font-bold">{TIER_LABELS[tier][locale]}</span>
              <span className="ml-auto tabular-nums text-muted-foreground">{range}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">{t.how.rarityNote}</p>
      </section>
      <section className="space-y-2">
        <h2 className="text-2xl font-extrabold">{t.how.sourcesTitle}</h2>
        <p className="text-muted-foreground">{t.how.sourcesBody}</p>
      </section>
    </article>
  );
}
