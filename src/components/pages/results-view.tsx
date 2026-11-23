"use client";

import Link from "next/link";
import { useState } from "react";
import { motion } from "motion/react";
import { Check, Share2 } from "lucide-react";
import { useApp } from "@/components/providers";
import { MountRoyalClimb } from "@/components/game/mount-royal-climb";
import { Button } from "@/components/ui/button";
import { CATEGORY_LABELS, TIER_LABELS } from "@/lib/i18n/dict";
import { TIER_COLOR, TIER_EMOJI } from "@/lib/client/fx";
import type { summarize } from "@/lib/game/engine";

type Summary = ReturnType<typeof summarize>;

export function ResultsView({
  summary,
  board,
  appeals,
}: {
  summary: Summary | null;
  board: { rank: number | null; players: number } | null;
  /** position → appeal status; null when the viewer can't appeal (not the owner, or no database). */
  appeals: Record<number, string> | null;
}) {
  const { t, locale } = useApp();
  const [copied, setCopied] = useState(false);

  if (!summary) {
    return (
      <div className="space-y-4 py-16 text-center">
        <p>{t.results.notFound}</p>
        <Link href="/" className="underline">
          {t.results.home}
        </Link>
      </div>
    );
  }

  const share = async () => {
    const grid = summary.rounds.map((r) => TIER_EMOJI[r.tier ?? "miss"]).join("");
    const head = summary.mode === "daily" ? `Montréallion ${summary.dateKey}` : "Montréallion Unlimited";
    const text = `${head}\n${grid} ${summary.total}/${summary.max}\n${location.origin}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* user dismissed share sheet */
    }
  };

  return (
    <div className="space-y-6">
      <section className="tile px-5 py-7 text-center">
        <p className="text-xs font-bold uppercase tracking-[0.2em] opacity-60">
          {summary.mode === "daily" ? t.results.daily(summary.dateKey ?? "") : t.results.unlimited}
        </p>
        <h1 className="mt-1 text-3xl font-extrabold">{t.results.title}</h1>
        <motion.p
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 220, damping: 14 }}
          className="mt-3 font-heading text-6xl font-extrabold tabular-nums"
          data-testid="final-score"
        >
          {summary.total}
          <span className="text-2xl opacity-50"> / {summary.max}</span>
        </motion.p>
        <p className="mt-3 text-3xl tracking-widest" aria-hidden>
          {summary.rounds.map((r) => TIER_EMOJI[r.tier ?? "miss"]).join("")}
        </p>
        {board?.rank && (
          <Link
            href={`/leaderboard?date=${summary.dateKey}`}
            className="mt-3 inline-block rounded-full border border-border px-3 py-1 text-sm font-bold hover:bg-muted"
            data-testid="daily-rank"
          >
            {t.results.rank(board.rank, board.players)} · {t.results.leaderboard} →
          </Link>
        )}
      </section>

      <MountRoyalClimb stops={summary.rounds.map((r) => ({ status: r.status, tier: r.tier, score: r.score }))} />

      <div className="flex flex-wrap gap-2">
        <Button onClick={share} className="h-11 flex-1 rounded-xl font-bold" data-testid="share">
          {copied ? <Check /> : <Share2 />}
          {copied ? t.results.copied : t.results.share}
        </Button>
        <Link href={`/map?game=${summary.id}`} className="inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-border font-bold hover:bg-muted" data-testid="results-map">
          {t.map.seeOnMap}
        </Link>
        <Link href="/play/unlimited" className="inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-border font-bold hover:bg-muted">
          {t.results.playUnlimited}
        </Link>
      </div>

      <ol className="space-y-3">
        {summary.rounds.map((r, i) => (
          <motion.li
            key={i}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + i * 0.06 }}
            className="flex gap-3 rounded-xl border border-border bg-card p-4"
          >
            <span
              className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full font-heading text-sm font-extrabold"
              style={{ background: r.tier ? TIER_COLOR[r.tier] : "var(--muted)", color: "oklch(0.18 0.03 262)" }}
            >
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">{CATEGORY_LABELS[r.category][locale]}</p>
              <p className="font-bold leading-snug">{r.prompt[locale]}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {r.input ? `“${r.input}”` : "—"}
                {r.reveal.matched && ` → ${r.reveal.matched[locale]}`}
                {r.tier && ` · ${TIER_LABELS[r.tier][locale]}`}
              </p>
              {appeals && r.status === "incorrect" && r.input && <Appeal sessionId={summary.id} position={i} initial={appeals[i] ?? null} />}
              {r.today && r.status === "correct" && (
                <p className="mt-0.5 text-xs text-muted-foreground" data-testid="today-count">
                  {t.results.today(Math.max(0, r.today.same - 1), r.today.players)}
                </p>
              )}
            </div>
            <span className="font-heading text-xl font-extrabold tabular-nums">{r.score}</span>
          </motion.li>
        ))}
      </ol>
      {appeals && summary.rounds.some((r) => r.status === "incorrect" && r.input) && (
        <p className="text-center text-xs text-muted-foreground">{t.results.appealHint}</p>
      )}
    </div>
  );
}

function Appeal({ sessionId, position, initial }: { sessionId: string; position: number; initial: string | null }) {
  const { t } = useApp();
  const [status, setStatus] = useState<string | null>(initial);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  if (status) {
    return (
      <p className="mt-1 text-xs font-bold text-muted-foreground" data-testid="appeal-status" data-status={status}>
        {t.results.appealStatus[status] ?? status}
      </p>
    );
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-1 text-xs font-bold underline underline-offset-2" data-testid="appeal-open">
        {t.results.appeal}
      </button>
    );
  }
  const send = async () => {
    setBusy(true);
    setError(false);
    const res = await fetch("/api/appeals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, position, note: note.trim() || null }),
    }).catch(() => null);
    setBusy(false);
    if (res && (res.status === 201 || res.status === 409)) setStatus("open");
    else setError(true);
  };
  return (
    <div className="mt-2 space-y-2">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        rows={2}
        placeholder={t.results.appealNote}
        className="w-full rounded-lg border border-border bg-background p-2 text-sm"
        data-testid="appeal-note"
      />
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={send} disabled={busy} data-testid="appeal-send">
          {t.results.appealSend}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t.results.appealCancel}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{t.results.appealError}</p>}
    </div>
  );
}
