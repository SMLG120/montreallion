"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "motion/react";
import { ArrowRight, Check, CornerDownLeft, Loader2, Pencil, SearchCheck } from "lucide-react";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { MetroLine, type StopState } from "./metro-line";
import { MountRoyalClimb } from "./mount-royal-climb";
import { CATEGORY_LABELS, SCOPE_LABELS, TIER_LABELS } from "@/lib/i18n/dict";
import { chime, recordDailyStreak, TIER_COLOR } from "@/lib/client/fx";
import type { CategoryId, Localized, PublicQuestion, Tier } from "@/lib/game/types";

type Mode = "daily" | "unlimited";
type RevealEntry = Localized & { score: number };
type AnswerResult = {
  status: "correct" | "incorrect" | "expired";
  score: number;
  tier: Tier | null;
  share: number | null;
  basis: "estimated" | "observed" | null;
  sample: number | null;
  matchedBy: "exact" | "fuzzy" | null;
  reveal: { matched: Localized | null; popular: RevealEntry[]; rarest: RevealEntry[]; total: number };
  runningScore: number;
  finished: boolean;
};

type CheckStatus = "match" | "possible" | "vague" | "none" | "limit" | "expired";
type CheckView = { status: CheckStatus; candidates: Localized[]; checksLeft: number; confirmBy: number | null };
/** Latest double-check; only valid while the input is unchanged. */
type CheckState = { input: string; view: CheckView; selected: number | null };

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "question"; q: PublicQuestion; deadline: number }
  | { kind: "reveal"; q: PublicQuestion; input: string; result: AnswerResult };

const ANSWER_SECONDS = 25;

async function post<T>(url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

export function GameClient({ mode, category }: { mode: Mode; category?: CategoryId }) {
  const { t, locale, sound } = useApp();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [session, setSession] = useState<{ id: string; total: number; dateKey: string | null } | null>(null);
  const [stops, setStops] = useState<StopState[]>(Array(7).fill(null));
  const [running, setRunning] = useState(0);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [remaining, setRemaining] = useState(ANSWER_SECONDS);
  const [resumed, setResumed] = useState(false);
  const [check, setCheck] = useState<CheckState | null>(null);
  const [checking, setChecking] = useState(false);
  const [graceLeft, setGraceLeft] = useState<number | null>(null);
  const offset = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextBtnRef = useRef<HTMLButtonElement>(null);
  const started = useRef(false);

  const finish = useCallback(
    (id: string, dateKey: string | null) => {
      if (mode === "daily" && dateKey) recordDailyStreak(dateKey);
      router.push(`/results/${id}`);
    },
    [mode, router],
  );

  const loadNext = useCallback(
    async (s: { id: string; total: number; dateKey: string | null }) => {
      setPhase({ kind: "loading" });
      const r = await post<{
        index: number;
        total: number;
        finished: boolean;
        runningScore: number;
        history: StopState[];
        question: PublicQuestion | null;
        deadline: number | null;
        serverNow: number;
      }>(`/api/game/${s.id}/next`);
      if (!r.ok) return setPhase({ kind: "error", message: r.status === 429 ? t.game.rateLimited : t.game.error });
      offset.current = r.data.serverNow - Date.now();
      setRunning(r.data.runningScore);
      setStops(Array.from({ length: r.data.total }, (_, i) => r.data.history[i] ?? null));
      if (r.data.finished || !r.data.question) return finish(s.id, s.dateKey);
      setInput("");
      setNotice(null);
      setCheck(null);
      setGraceLeft(null);
      setPhase({ kind: "question", q: r.data.question, deadline: r.data.deadline! });
    },
    [finish, t.game.error, t.game.rateLimited],
  );

  // Start or resume a session once.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const r = await post<{ sessionId: string; total: number; dateKey: string | null; index: number; finished: boolean }>("/api/game", { mode, category });
      if (!r.ok) return setPhase({ kind: "error", message: r.status === 429 ? t.game.rateLimited : r.status === 422 ? t.game.unavailable : t.game.error });
      const s = { id: r.data.sessionId, total: r.data.total, dateKey: r.data.dateKey };
      setSession(s);
      if (r.data.finished) return finish(s.id, s.dateKey);
      if (mode === "daily" && r.data.index > 0) setResumed(true);
      await loadNext(s);
    })();
  }, [mode, category, loadNext, finish, t.game.error, t.game.rateLimited, t.game.unavailable]);

  const submit = useCallback(
    async (value: string, choice?: number) => {
      if (phase.kind !== "question" || !session || submitting) return;
      setSubmitting(true);
      const r = await post<AnswerResult | { status: "retry" }>(`/api/game/${session.id}/answer`, { index: phase.q.index, answer: value, choice });
      setSubmitting(false);
      if (!r.ok) {
        // 409 = already answered / out of sync: resync with the server.
        if (r.status === 409) return loadNext(session);
        return setNotice(r.status === 429 ? t.game.rateLimited : t.game.error);
      }
      if (r.data.status === "retry") {
        setCheck(null);
        setNotice(t.game.retry);
        inputRef.current?.focus();
        return;
      }
      const result = r.data as AnswerResult;
      if (sound) chime(result.tier === "legend" ? "legend" : result.status === "correct" ? "correct" : "wrong");
      setStops((prev) => prev.map((x, i) => (i === phase.q.index ? { status: result.status, tier: result.tier, score: result.score } : x)));
      setRunning(result.runningScore);
      setPhase({ kind: "reveal", q: phase.q, input: value, result });
    },
    [phase, session, submitting, sound, loadNext, t.game.error, t.game.rateLimited, t.game.retry],
  );

  /** Double-check: never consumes the question and never shows points or rarity. */
  const runCheck = useCallback(
    async (value: string) => {
      if (phase.kind !== "question" || !session || checking || submitting) return;
      setChecking(true);
      const r = await post<CheckView & { serverNow: number }>(`/api/game/${session.id}/check`, { index: phase.q.index, answer: value });
      setChecking(false);
      if (!r.ok) {
        if (r.status === 409) return loadNext(session);
        return setNotice(r.status === 429 ? t.game.rateLimited : t.game.error);
      }
      offset.current = r.data.serverNow - Date.now();
      const view: CheckView = { status: r.data.status, candidates: r.data.candidates, checksLeft: r.data.checksLeft, confirmBy: r.data.confirmBy };
      if (view.status === "expired") return void submit(value);
      // A single candidate is pre-selected; several require an explicit pick.
      setCheck({ input: value, view, selected: view.candidates.length === 1 ? 0 : null });
    },
    [phase, session, checking, submitting, submit, loadNext, t.game.error, t.game.rateLimited],
  );

  const current = check && check.input === input ? check : null;
  /** Primary action: check first; confirm once the current input has been checked. */
  const primary = useCallback(() => {
    if (!input.trim()) return;
    if (!current) return void runCheck(input);
    const { view, selected } = current;
    if ((view.status === "match" || view.status === "possible") && selected !== null) return void submit(input, selected);
    if (view.status === "none" || view.status === "limit") return void submit(input);
  }, [input, current, runCheck, submit]);

  // Server-anchored countdown; auto-submits when time runs out, after a bounded grace if the answer was checked in time.
  const inputLatest = useRef(input);
  const checkLatest = useRef(current);
  useEffect(() => {
    inputLatest.current = input;
    checkLatest.current = current;
  }, [input, current]);
  useEffect(() => {
    if (phase.kind !== "question") return;
    inputRef.current?.focus();
    let fired = false;
    let lastTick = -1;
    const id = setInterval(() => {
      const left = Math.max(0, (phase.deadline - (Date.now() + offset.current)) / 1000);
      setRemaining(left);
      const whole = Math.ceil(left);
      if (sound && whole <= 5 && whole > 0 && whole !== lastTick) chime("tick");
      lastTick = whole;
      if (left > 0 || fired) return;
      const c = checkLatest.current;
      const graceEnd = c?.view.confirmBy ?? null;
      const nowServer = Date.now() + offset.current;
      if (graceEnd !== null && graceEnd > phase.deadline && nowServer < graceEnd) {
        setGraceLeft(Math.ceil((graceEnd - nowServer) / 1000));
        return;
      }
      fired = true;
      setGraceLeft(null);
      // The server only honours a choice that matches its own record of the check.
      void submit(inputLatest.current, c && c.selected !== null && (c.view.status === "match" || c.view.status === "possible") ? c.selected : undefined);
    }, 100);
    return () => clearInterval(id);
  }, [phase, submit, sound]);

  useEffect(() => {
    if (phase.kind === "reveal") nextBtnRef.current?.focus();
  }, [phase.kind]);

  const total = session?.total ?? 7;
  const currentIndex = phase.kind === "question" || phase.kind === "reveal" ? phase.q.index : stops.filter(Boolean).length;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{mode === "daily" ? t.nav.daily : t.nav.unlimited}</p>
          <p className="font-heading text-xl font-bold">{t.game.stop(Math.min(currentIndex + 1, total), total)}</p>
        </div>
        <div className="text-right" aria-live="polite">
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{t.game.total}</p>
          <p className="font-heading text-2xl font-extrabold tabular-nums" data-testid="running-score">
            {running}
          </p>
        </div>
      </div>

      <MetroLine stops={stops} current={currentIndex} label={t.game.stop(Math.min(currentIndex + 1, total), total)} />

      <MountRoyalClimb stops={stops} compact />

      {resumed && <p className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">{t.game.resumeNote}</p>}

      <AnimatePresence mode="wait">
        {phase.kind === "loading" && (
          <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="grid place-items-center gap-3 py-20 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" aria-hidden />
            <p>{t.game.loading}</p>
          </motion.div>
        )}

        {phase.kind === "error" && (
          <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4 py-16 text-center">
            <p>{phase.message}</p>
            <Button onClick={() => location.reload()}>↻</Button>
          </motion.div>
        )}

        {phase.kind === "question" && (
          <motion.section
            key={`q-${phase.q.index}`}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
            className="space-y-5"
            aria-labelledby="prompt"
          >
            <QuestionCard q={phase.q} />
            <Timer remaining={remaining} />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                primary();
              }}
              className="flex gap-2"
            >
              <label htmlFor="answer" className="sr-only">
                {t.game.placeholder}
              </label>
              <input
                id="answer"
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  if (notice) setNotice(null);
                }}
                placeholder={t.game.placeholder}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint={current ? "send" : "go"}
                maxLength={120}
                disabled={submitting}
                aria-describedby="answer-hint"
                className="h-14 min-w-0 flex-1 rounded-xl border-2 border-input bg-card px-4 text-lg outline-none transition-colors placeholder:text-muted-foreground focus:border-ring"
                data-testid="answer-input"
              />
              <Button
                type="submit"
                disabled={submitting || checking || !input.trim() || (!!current && !canConfirm(current))}
                className="h-14 min-w-28 rounded-xl px-5 text-base font-bold"
                data-testid="submit-answer"
                data-action={current ? "confirm" : "check"}
              >
                {submitting || checking ? <Loader2 className="animate-spin" /> : current ? <Check /> : <SearchCheck />}
                <span className="hidden sm:inline">{current ? (current.view.status === "none" || current.view.status === "limit" ? t.game.submitTyped : t.game.confirm) : t.game.check}</span>
              </Button>
            </form>
            <p id="answer-hint" className="-mt-3 min-h-5 text-xs text-muted-foreground">
              {graceLeft !== null ? <span className="font-bold text-line-yellow" role="status">{t.game.grace(graceLeft)}</span> : !current ? t.game.checkHint : null}
            </p>
            <AnimatePresence initial={false}>
              {current && (
                <CheckPanel
                  key={current.input}
                  state={current}
                  disabled={submitting}
                  onSelect={(i) => setCheck({ ...current, selected: i })}
                  onConfirm={(i) => void submit(input, i)}
                  onSubmitTyped={() => void submit(input)}
                  onEdit={() => {
                    setCheck(null);
                    inputRef.current?.focus();
                    inputRef.current?.select();
                  }}
                />
              )}
            </AnimatePresence>
            <AnimatePresence>
              {notice && (
                <motion.p
                  role="status"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0, x: [0, -6, 6, -3, 0] }}
                  exit={{ opacity: 0 }}
                  className="rounded-lg bg-line-yellow/15 px-3 py-2 text-sm text-line-yellow"
                >
                  {notice}
                </motion.p>
              )}
            </AnimatePresence>
          </motion.section>
        )}

        {phase.kind === "reveal" && (
          <motion.section key={`r-${phase.q.index}`} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, x: -40 }} className="space-y-4">
            <RevealCard input={phase.input} result={phase.result} />
            <Button
              ref={nextBtnRef}
              onClick={() => (phase.result.finished ? finish(session!.id, session!.dateKey) : loadNext(session!))}
              className="h-12 w-full rounded-xl text-base font-bold"
              data-testid="next-stop"
            >
              {phase.result.finished ? t.game.finish : t.game.next}
              <ArrowRight />
            </Button>
          </motion.section>
        )}
      </AnimatePresence>
      <span className="sr-only" lang={locale}>
        {phase.kind === "question" ? `${Math.ceil(remaining)} ${t.game.seconds}` : ""}
      </span>
    </div>
  );
}

function canConfirm(c: CheckState): boolean {
  const st = c.view.status;
  return st === "none" || st === "limit" || ((st === "match" || st === "possible") && c.selected !== null);
}

const CHECK_TONE: Record<CheckStatus, string> = {
  match: "var(--line-green)",
  possible: "var(--line-yellow)",
  vague: "var(--line-yellow)",
  none: "var(--line-orange)",
  limit: "var(--line-orange)",
  expired: "var(--destructive)",
};

/** MATCH FOUND / POSSIBLE MATCH / NOT RECOGNIZED, with entity selection. Labels only: no points or rarity. */
function CheckPanel({
  state,
  disabled,
  onSelect,
  onConfirm,
  onSubmitTyped,
  onEdit,
}: {
  state: CheckState;
  disabled: boolean;
  onSelect: (i: number) => void;
  onConfirm: (i: number) => void;
  onSubmitTyped: () => void;
  onEdit: () => void;
}) {
  const { t, locale } = useApp();
  const { view, selected, input } = state;
  const tone = CHECK_TONE[view.status];
  const title =
    view.status === "match" ? t.game.matchFound : view.status === "possible" || view.status === "vague" ? t.game.possibleMatch : view.status === "limit" ? t.game.checksLeft(0) : t.game.notRecognized;
  const sameAsTyped = (c: Localized) => c.en.localeCompare(input.trim(), undefined, { sensitivity: "base" }) === 0 || c.fr.localeCompare(input.trim(), undefined, { sensitivity: "base" }) === 0;
  const one = view.candidates.length === 1 ? view.candidates[0] : null;
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="space-y-3 rounded-xl border-2 bg-card p-4"
      style={{ borderColor: `color-mix(in oklch, ${tone} 60%, transparent)` }}
      data-testid="check-panel"
      data-status={view.status}
    >
      <div className="flex items-center justify-between gap-2" role="status" aria-live="polite">
        <span className="rounded-full px-2.5 py-0.5 text-xs font-extrabold uppercase tracking-wider" style={{ background: tone, color: "oklch(0.18 0.03 262)" }}>
          {title}
        </span>
        {view.status !== "limit" && <span className="text-xs text-muted-foreground">{t.game.checksLeft(view.checksLeft)}</span>}
      </div>

      {one && (
        <p className="text-base">
          {view.status === "possible" || !sameAsTyped(one) ? `${t.game.didYouMean} ` : `${t.game.countsAs} `}
          <strong className="font-heading text-lg" data-testid="candidate-label">
            {one[locale]}
          </strong>
          {view.status === "possible" || !sameAsTyped(one) ? (locale === "fr" ? " ?" : "?") : ""}
        </p>
      )}

      {view.candidates.length > 1 && (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm">{t.game.pickOne}</legend>
          {view.candidates.map((c, i) => (
            <label
              key={`${c.en}-${i}`}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 has-[:checked]:border-ring has-[:checked]:bg-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
              data-testid={`candidate-${i}`}
            >
              <input type="radio" name="candidate" className="size-4 accent-[var(--line-green)]" checked={selected === i} onChange={() => onSelect(i)} disabled={disabled} />
              <span className="font-bold">{c[locale]}</span>
            </label>
          ))}
        </fieldset>
      )}

      {view.status === "none" && <p className="text-sm text-muted-foreground">{t.game.notRecognizedHelp}</p>}
      {view.status === "vague" && <p className="text-sm text-muted-foreground">{t.game.retry}</p>}
      {view.status === "limit" && <p className="text-sm text-muted-foreground">{t.game.limitReached}</p>}

      <div className="flex flex-wrap gap-2">
        {(view.status === "match" || view.status === "possible") && (
          <Button type="button" className="min-h-11 flex-1 font-bold" disabled={disabled || selected === null} onClick={() => selected !== null && onConfirm(selected)} data-testid="confirm-answer">
            <Check /> {t.game.confirm}
          </Button>
        )}
        {(view.status === "none" || view.status === "limit") && (
          <Button type="button" className="min-h-11 flex-1 font-bold" disabled={disabled} onClick={onSubmitTyped} data-testid="submit-typed">
            <CornerDownLeft /> {t.game.submitTyped}
          </Button>
        )}
        <Button type="button" variant="outline" className="min-h-11" disabled={disabled} onClick={onEdit} data-testid="edit-answer">
          <Pencil /> {t.game.edit}
        </Button>
        {view.status === "possible" && (
          <Button type="button" variant="ghost" className="min-h-11 w-full text-muted-foreground" disabled={disabled} onClick={onSubmitTyped} data-testid="submit-typed">
            {t.game.noneOfThese}
          </Button>
        )}
      </div>
    </motion.div>
  );
}

function QuestionCard({ q }: { q: PublicQuestion }) {
  const { locale, t } = useApp();
  return (
    <div className="tile overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 bg-[oklch(0.2_0.03_262)] px-4 py-2 text-xs font-bold uppercase tracking-wider text-[var(--tile)]">
        <span className="size-2.5 rounded-full bg-line-orange" aria-hidden />
        {CATEGORY_LABELS[q.category][locale]}
        <span className="ml-auto font-normal normal-case tracking-normal opacity-80">{SCOPE_LABELS[q.scope][locale]}</span>
      </div>
      <div className="space-y-3 px-5 py-6 sm:px-7">
        <h1 id="prompt" className="font-heading text-2xl font-extrabold leading-tight sm:text-3xl" data-testid="prompt">
          {q.prompt[locale]}
        </h1>
        <p className="text-sm opacity-75">{q.eligibility[locale]}</p>
        <p className="text-xs font-bold uppercase tracking-wider opacity-60">
          {t.game.validCount(q.answerCount)}
          {q.verification === "editor-curated" && ` · ${t.game.curated}`}
        </p>
      </div>
    </div>
  );
}

function Timer({ remaining }: { remaining: number }) {
  const pct = Math.max(0, Math.min(1, remaining / ANSWER_SECONDS));
  const urgent = remaining <= 5;
  return (
    <div className="flex items-center gap-3" aria-hidden>
      <div className="h-3 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-[width] duration-100 ease-linear"
          style={{ width: `${pct * 100}%`, background: urgent ? "var(--destructive)" : pct < 0.5 ? "var(--line-yellow)" : "var(--line-green)" }}
        />
      </div>
      <span className={`w-12 text-right font-heading text-2xl font-extrabold tabular-nums ${urgent ? "text-destructive" : ""}`} data-testid="timer">
        {Math.ceil(remaining)}
      </span>
    </div>
  );
}

function CountUp({ to }: { to: number }) {
  const mv = useMotionValue(0);
  const rounded = useTransform(mv, (v) => Math.round(v));
  useEffect(() => {
    const c = animate(mv, to, { duration: 0.9, ease: [0.2, 0.8, 0.2, 1] });
    return () => c.stop();
  }, [mv, to]);
  return <motion.span>{rounded}</motion.span>;
}

function RevealCard({ input, result }: { input: string; result: AnswerResult }) {
  const { t, locale } = useApp();
  const correct = result.status === "correct";
  const color = correct && result.tier ? TIER_COLOR[result.tier] : "var(--destructive)";
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card" data-testid="reveal" data-status={result.status}>
      <div className="relative px-5 pb-5 pt-6 text-center" style={{ background: `linear-gradient(180deg, color-mix(in oklch, ${color} 22%, transparent), transparent)` }}>
        <motion.p initial={{ y: 8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="text-sm font-bold uppercase tracking-[0.2em]" style={{ color }}>
          {correct ? t.game.correct : result.status === "expired" ? t.game.expired : t.game.incorrect}
        </motion.p>
        <p className="mt-1 font-heading text-7xl font-extrabold tabular-nums" data-testid="round-score">
          <CountUp to={result.score} />
          <span className="ml-1 text-2xl text-muted-foreground">{t.game.points}</span>
        </p>
        {correct && result.tier && (
          <motion.div
            initial={{ scale: 0.4, opacity: 0, rotate: -6 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            transition={{ delay: 0.75, type: "spring", stiffness: 380, damping: 14 }}
            className="mt-3 inline-block rounded-full px-4 py-1.5 font-heading text-lg font-extrabold"
            style={{ background: color, color: "oklch(0.18 0.03 262)" }}
            data-testid="tier"
          >
            {TIER_LABELS[result.tier][locale]}
          </motion.div>
        )}
      </div>
      <dl className="grid gap-3 border-t border-border px-5 py-4 text-sm">
        {input && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t.game.yourAnswer}</dt>
            <dd className="text-right font-bold">{input}</dd>
          </div>
        )}
        {result.reveal.matched && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t.game.matched}</dt>
            <dd className="text-right font-bold">
              {result.reveal.matched[locale]}
              {result.matchedBy === "fuzzy" && <span className="ml-1 font-normal text-muted-foreground">({t.game.typo})</span>}
            </dd>
          </div>
        )}
        {result.share !== null &&
          (result.basis === "observed" && result.sample ? (
            <p className="text-xs text-muted-foreground" data-testid="rarity-basis" data-basis="observed">
              {t.game.observed(Math.max(1, Math.round(result.share * 100)), result.sample)} · <em>{t.game.observedLabel}</em>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="rarity-basis" data-basis="estimated">
              {t.game.estimated(Math.max(1, Math.round(result.share * 100)))} · <em>{t.game.estimatedLabel}</em>
            </p>
          ))}
      </dl>
      <div className="grid gap-4 border-t border-border px-5 py-4 text-sm sm:grid-cols-2">
        <AnswerList title={t.game.popular} items={result.reveal.popular} />
        <AnswerList title={t.game.rarest} items={result.reveal.rarest} />
        <p className="text-xs text-muted-foreground sm:col-span-2">{t.game.validCount(result.reveal.total)}</p>
      </div>
    </div>
  );
}

function AnswerList({ title, items }: { title: string; items: RevealEntry[] }) {
  const { locale } = useApp();
  return (
    <div>
      <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</p>
      <ul className="space-y-1">
        {items.map((a) => (
          <li key={a.en} className="flex justify-between gap-2">
            <span>{a[locale]}</span>
            <span className="tabular-nums text-muted-foreground">{a.score}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
