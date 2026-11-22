"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { motion } from "motion/react";
import { ChevronLeft, ChevronRight, Trophy } from "lucide-react";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import type { getBoard } from "@/lib/game/board";

type BoardData = Awaited<ReturnType<typeof getBoard>>;
type Entry = BoardData["top"][number];

function shiftDay(key: string, days: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function LeaderboardView({ board }: { board: BoardData }) {
  const { t } = useApp();
  const L = t.leaderboard;
  const isToday = board.dateKey === board.today;
  const youShownInTop = board.you && board.top.some((e) => e.you);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-4xl font-extrabold">
          <Trophy className="size-8 text-[var(--line-yellow)]" aria-hidden /> {L.title}
        </h1>
        <div className="flex items-center justify-between gap-2">
          <Link href={`/leaderboard?date=${shiftDay(board.dateKey, -1)}`} className="rounded-lg p-2 hover:bg-muted" aria-label={L.prev}>
            <ChevronLeft />
          </Link>
          <p className="text-center font-bold" data-testid="board-date">
            {L.day(board.dateKey)} · <span className="text-muted-foreground">{L.players(board.players)}</span>
          </p>
          {isToday ? (
            <span className="size-10" />
          ) : (
            <Link href={`/leaderboard?date=${shiftDay(board.dateKey, 1)}`} className="rounded-lg p-2 hover:bg-muted" aria-label={L.next}>
              <ChevronRight />
            </Link>
          )}
        </div>
      </header>

      {board.top.length === 0 ? (
        <p className="tile px-5 py-8 text-center text-muted-foreground">{L.empty}</p>
      ) : (
        <ol className="overflow-hidden rounded-xl border border-border" data-testid="board">
          {board.top.map((e, i) => (
            <Row key={`${e.rank}-${e.tag}-${i}`} e={e} i={i} />
          ))}
          {board.you && !youShownInTop && (
            <>
              <li className="border-t border-dashed border-border px-4 py-1 text-center text-muted-foreground">⋯</li>
              <Row e={board.you} i={board.top.length} />
            </>
          )}
        </ol>
      )}
      <p className="text-xs text-muted-foreground">{L.tiebreak}</p>

      {isToday && !board.you && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
          <p className="text-sm text-muted-foreground">{L.notRanked}</p>
          <Link href="/play/daily" className="rounded-xl bg-primary px-4 py-2 font-bold text-primary-foreground">
            {L.play}
          </Link>
        </div>
      )}

      <NameForm initial={board.yourName} />
    </div>
  );
}

function Row({ e, i }: { e: Entry; i: number }) {
  const { t } = useApp();
  return (
    <motion.li
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(i, 20) * 0.025 }}
      className={`flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0 ${e.you ? "bg-[color-mix(in_oklch,var(--line-yellow)_14%,transparent)]" : ""}`}
      data-testid={e.you ? "board-you" : "board-row"}
    >
      <span className="w-8 font-heading text-lg font-extrabold tabular-nums">{e.rank}</span>
      <span className="min-w-0 flex-1 truncate font-bold">
        {e.name ?? <span className="font-normal text-muted-foreground">{t.leaderboard.anon(e.tag)}</span>}
        {e.you && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-bold uppercase">{t.leaderboard.you}</span>}
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">{seconds(e.elapsedMs)}</span>
      <span className="w-12 text-right font-heading text-xl font-extrabold tabular-nums">{e.score}</span>
    </motion.li>
  );
}

function NameForm({ initial }: { initial: string | null }) {
  const { t } = useApp();
  const L = t.leaderboard;
  const router = useRouter();
  const [value, setValue] = useState(initial ?? "");
  const [state, setState] = useState<{ kind: "idle" | "saving" | "saved" } | { kind: "error"; msg: string }>({ kind: "idle" });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setState({ kind: "saving" });
    const res = await fetch("/api/player", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: value.trim() || null }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) {
      const code = data.error as keyof typeof L.nameErrors;
      setState({ kind: "error", msg: L.nameErrors[code] ?? L.nameErrors.generic });
      return;
    }
    setValue(data.displayName ?? "");
    setState({ kind: "saved" });
    router.refresh();
  };

  return (
    <form onSubmit={save} className="space-y-2 rounded-xl border border-border p-4">
      <label htmlFor="display-name" className="block font-bold">
        {L.nameTitle}
      </label>
      <div className="flex gap-2">
        <input
          id="display-name"
          data-testid="display-name"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setState({ kind: "idle" });
          }}
          maxLength={20}
          autoComplete="nickname"
          placeholder={L.namePlaceholder}
          className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-background px-3"
        />
        <Button type="submit" className="h-11 rounded-xl px-5 font-bold" disabled={state.kind === "saving"} data-testid="save-name">
          {state.kind === "saved" ? L.saved : L.save}
        </Button>
      </div>
      <p className={`text-xs ${state.kind === "error" ? "text-destructive" : "text-muted-foreground"}`} role={state.kind === "error" ? "alert" : undefined} data-testid="name-msg">
        {state.kind === "error" ? state.msg : L.nameHelp}
      </p>
    </form>
  );
}
