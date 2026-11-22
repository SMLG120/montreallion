"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, Crown, Loader2 } from "lucide-react";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { TIER_COLOR } from "@/lib/client/fx";
import { CATEGORY_LABELS, SCOPE_LABELS, TIER_LABELS } from "@/lib/i18n/dict";
import type { PartyView, RoundReveal, Standing } from "@/lib/game/party";

const POLL_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Action = { action: "join"; name: string } | { action: "start" } | { action: "answer"; round: number; answer: string } | { action: "next" } | { action: "leave" };

/**
 * Live room. State comes from polling GET /api/party/:code (ETag → 304 when nothing changed);
 * the server owns every clock, the client only renders countdowns using a measured clock offset.
 */
export function PartyRoom({ code }: { code: string }) {
  const { t } = useApp();
  const P = t.party;
  const [view, setView] = useState<PartyView | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const offset = useRef(0);
  const etag = useRef<string | null>(null);
  const finished = useRef(false);
  /** Bumped by every action; a poll that started before an action is stale and must not overwrite its result. */
  const seq = useRef(0);

  const poll = useCallback(async () => {
    const t0 = Date.now();
    const started = seq.current;
    const r = await fetch(`/api/party/${code}`, { cache: "no-store", headers: etag.current ? { "If-None-Match": etag.current } : {} }).catch(() => null);
    if (!r) return;
    const server = Number(r.headers.get("X-Server-Now"));
    if (server) offset.current = server - (t0 + Date.now()) / 2;
    if (r.status === 304 || started !== seq.current) return;
    if (r.status === 404) return setMissing(true);
    if (!r.ok) return;
    etag.current = r.headers.get("ETag");
    const v = (await r.json()) as PartyView;
    if (started !== seq.current) return;
    finished.current = v.phase === "finished";
    setView(v);
  }, [code]);

  useEffect(() => {
    let stop = false;
    (async () => {
      while (!stop) {
        await poll();
        await sleep(finished.current ? POLL_MS * 5 : POLL_MS);
      }
    })();
    return () => {
      stop = true;
    };
  }, [poll]);

  useEffect(() => {
    // Server-clock "now" (ref read inside the callback, not during render).
    const id = setInterval(() => setNow(Date.now() + offset.current), 250);
    return () => clearInterval(id);
  }, []);

  const act = useCallback(
    async (a: Action): Promise<{ ok: boolean; result?: { status: string } | null; error?: string }> => {
      setError(null);
      seq.current += 1;
      const r = await fetch(`/api/party/${code}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(a) }).catch(() => null);
      const d = r ? await r.json().catch(() => ({})) : {};
      seq.current += 1; // also invalidate polls that started while this action was in flight
      if (r?.ok) {
        etag.current = null;
        if (d.view) setView(d.view);
        return { ok: true, result: d.result };
      }
      if (r?.status === 404) setMissing(true);
      return { ok: false, error: d.error ?? "generic" };
    },
    [code],
  );

  const serverNow = now;

  if (missing) {
    return (
      <div className="space-y-4 py-12 text-center">
        <p data-testid="party-missing">{P.notFound}</p>
        <Link href="/party" className="underline">
          {P.newGame}
        </Link>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="grid place-items-center py-20">
        <Loader2 className="size-8 animate-spin" aria-label="…" />
      </div>
    );
  }

  if (!view.you.member) {
    return view.phase === "lobby" ? <JoinForm code={code} act={act} /> : <p className="py-12 text-center">{P.started}</p>;
  }

  return (
    <div className="space-y-6" data-testid="party-room" data-phase={view.phase}>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {view.phase === "lobby" && <Lobby view={view} act={act} onError={(e) => setError(P.errors[e] ?? P.errors.generic)} />}
      {view.phase === "question" && <QuestionPhase key={view.round} view={view} serverNow={serverNow} act={act} />}
      {view.phase === "reveal" && view.reveal && (
        <div className="space-y-6">
          <RevealCard reveal={view.reveal} total={view.totalRounds} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" data-testid="next-in">
              {P.nextIn(Math.max(0, Math.ceil(((view.revealUntil ?? serverNow) - serverNow) / 1000)))}
            </p>
            {view.you.host && (
              <Button onClick={() => act({ action: "next" })} className="h-11 rounded-xl font-bold" data-testid="party-next">
                {P.next}
              </Button>
            )}
          </div>
          <Standings title={P.standings} members={view.members} />
        </div>
      )}
      {view.phase === "finished" && <Finished view={view} />}
    </div>
  );
}

function JoinForm({ code, act }: { code: string; act: (a: Action) => Promise<{ ok: boolean; error?: string }> }) {
  const { t } = useApp();
  const P = t.party;
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/player")
      .then((r) => r.json())
      .then((d) => d.displayName && setName((n) => n || d.displayName))
      .catch(() => {});
  }, []);
  return (
    <form
      className="mx-auto max-w-sm space-y-4 py-8"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await act({ action: "join", name });
        if (!r.ok) setErr(P.errors[r.error ?? "generic"] ?? P.errors.generic);
      }}
    >
      <h1 className="text-3xl font-extrabold">
        {P.join} <span className="font-mono tracking-widest">{code}</span>
      </h1>
      <label className="block space-y-1 font-bold">
        <span>{P.yourName}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} className="h-11 w-full rounded-xl border border-border bg-background px-3" data-testid="party-name" />
      </label>
      {err && (
        <p className="text-sm text-destructive" role="alert" data-testid="party-error">
          {err}
        </p>
      )}
      <Button type="submit" className="h-11 w-full rounded-xl font-bold" data-testid="party-join">
        {P.joinCta}
      </Button>
    </form>
  );
}

function Lobby({ view, act, onError }: { view: PartyView; act: (a: Action) => Promise<{ ok: boolean; error?: string }>; onError: (e: string) => void }) {
  const { t, locale } = useApp();
  const P = t.party;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/party/${view.code}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div className="space-y-6">
      <section className="tile px-5 py-7 text-center">
        <p className="text-xs font-bold uppercase tracking-[0.2em] opacity-60">{P.roomCode}</p>
        <p className="mt-1 font-mono text-6xl font-extrabold tracking-[0.25em]" data-testid="party-code-display">
          {view.code}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {view.totalRounds} × {P.rounds.toLowerCase()} · {view.settings.category ? CATEGORY_LABELS[view.settings.category][locale] : P.anyCategory}
        </p>
        <Button variant="outline" onClick={copy} className="mt-4 rounded-xl">
          {copied ? <Check /> : <Copy />} {copied ? P.copied : P.invite}
        </Button>
      </section>
      <Standings title={P.players(view.members.length)} members={view.members} hideScores />
      {view.you.host ? (
        <div className="space-y-2">
          <Button
            onClick={async () => {
              const r = await act({ action: "start" });
              if (!r.ok) onError(r.error ?? "generic");
            }}
            className="h-12 w-full rounded-xl text-lg font-bold"
            data-testid="party-start"
          >
            {P.start}
          </Button>
          {view.members.length === 1 && <p className="text-center text-sm text-muted-foreground">{P.soloHint}</p>}
        </div>
      ) : (
        <p className="text-center text-muted-foreground" data-testid="party-waiting-host">
          {P.waitingHost(view.hostName)}
        </p>
      )}
    </div>
  );
}

function QuestionPhase({ view, serverNow, act }: { view: PartyView; serverNow: number; act: (a: Action) => Promise<{ ok: boolean; result?: { status: string } | null }> }) {
  const { t, locale } = useApp();
  const P = t.party;
  const q = view.question!;
  const [value, setValue] = useState("");
  const [retry, setRetry] = useState(false);
  const [busy, setBusy] = useState(false);
  const left = Math.max(0, Math.ceil(((view.deadline ?? serverNow) - serverNow) / 1000));
  const active = view.members.filter((m) => m.active).length || view.members.length;

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setRetry(false);
    const r = await act({ action: "answer", round: view.round, answer: value });
    setBusy(false);
    if (r.ok && r.result?.status === "retry") setRetry(true);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between">
        <p className="font-heading text-xl font-bold">{P.round(view.round + 1, view.totalRounds)}</p>
        <p className={`font-heading text-3xl font-extrabold tabular-nums ${left <= 5 ? "text-destructive" : ""}`} data-testid="party-timer">
          {left}
          <span className="text-base opacity-60">{t.game.seconds}</span>
        </p>
      </div>
      <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="tile space-y-3 px-5 py-6">
        <p className="text-xs font-bold uppercase tracking-[0.18em] opacity-70">
          {CATEGORY_LABELS[q.category][locale]} · {SCOPE_LABELS[q.scope][locale]}
        </p>
        <h2 className="text-2xl font-extrabold leading-tight" data-testid="prompt">
          {q.prompt[locale]}
        </h2>
        <p className="text-sm opacity-75">{q.eligibility[locale]}</p>
      </motion.section>
      {view.you.answered ? (
        <div className="space-y-1 rounded-xl border border-border p-4" data-testid="party-locked">
          <p className="font-bold">{view.you.input ? P.locked(view.you.input) : P.lockedEmpty}</p>
          <p className="text-sm text-muted-foreground">{P.waitingOthers(view.answeredCount, active)}</p>
        </div>
      ) : (
        <form onSubmit={send} className="space-y-2">
          <div className="flex gap-2">
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={120}
              placeholder={t.game.placeholder}
              className="h-12 min-w-0 flex-1 rounded-xl border border-border bg-background px-4 text-lg"
              data-testid="answer-input"
              enterKeyHint="send"
              autoComplete="off"
            />
            <Button type="submit" disabled={busy || left === 0} className="h-12 rounded-xl px-5 font-bold" data-testid="answer-submit">
              {t.game.submit}
            </Button>
          </div>
          {retry && (
            <p className="text-sm font-bold text-[var(--line-orange)]" role="status">
              {t.game.retry}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{P.waitingOthers(view.answeredCount, active)}</p>
        </form>
      )}
    </div>
  );
}

function RevealCard({ reveal, total }: { reveal: RoundReveal; total: number }) {
  const { t, locale } = useApp();
  const P = t.party;
  return (
    <section className="space-y-4" data-testid="party-reveal">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{P.round(reveal.index + 1, total)}</p>
        <h2 className="text-xl font-extrabold leading-snug">{reveal.prompt[locale]}</h2>
      </div>
      <ul className="space-y-2">
        <AnimatePresence initial>
          {reveal.answers.map((a, i) => (
            <motion.li
              key={a.name}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.08 }}
              className={`flex items-center gap-3 rounded-xl border border-border p-3 ${a.you ? "bg-muted" : ""}`}
              data-testid="reveal-answer"
            >
              <span className="size-3 shrink-0 rounded-full" style={{ background: a.tier ? TIER_COLOR[a.tier] : "var(--muted-foreground)" }} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-bold">
                  {a.name}
                  {a.you && <span className="ml-2 text-xs uppercase text-muted-foreground">{P.you}</span>}
                </p>
                <p className="truncate text-sm text-muted-foreground">
                  {a.input ? `“${a.input}”` : P.noAnswer}
                  {a.matched && ` → ${a.matched[locale]}`}
                  {a.tier && ` · ${TIER_LABELS[a.tier][locale]}`}
                  {a.same > 0 && ` · ${P.sameAs(a.same)}`}
                </p>
              </div>
              <span className="font-heading text-2xl font-extrabold tabular-nums">{a.score}</span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">{t.game.popular}</p>
          <p>{reveal.popular.map((x) => `${x[locale]} (${x.score})`).join(" · ")}</p>
        </div>
        <div>
          <p className="mb-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">{t.game.rarest}</p>
          <p>{reveal.rarest.map((x) => `${x[locale]} (${x.score})`).join(" · ")}</p>
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2">{t.game.validCount(reveal.total)}</p>
      </div>
    </section>
  );
}

function Standings({ title, members, hideScores }: { title: string; members: Standing[]; hideScores?: boolean }) {
  const { t } = useApp();
  const P = t.party;
  return (
    <section className="space-y-2">
      <h2 className="font-bold">{title}</h2>
      <ol className="overflow-hidden rounded-xl border border-border" data-testid="party-members">
        {members.map((m) => (
          <li key={m.name} className={`flex items-center gap-3 border-t border-border px-4 py-2.5 first:border-t-0 ${m.you ? "bg-muted" : ""}`}>
            {!hideScores && <span className="w-6 font-heading font-extrabold tabular-nums">{m.rank}</span>}
            <span className={`min-w-0 flex-1 truncate font-bold ${m.active ? "" : "opacity-50"}`}>
              {m.name}
              {m.host && <Crown className="ml-1.5 inline size-4 text-[var(--line-yellow)]" aria-label={P.host} />}
              {m.you && <span className="ml-2 text-xs uppercase text-muted-foreground">{P.you}</span>}
              {!m.active && <span className="ml-2 text-xs text-muted-foreground">({P.away})</span>}
            </span>
            {!hideScores && <span className="font-heading text-xl font-extrabold tabular-nums">{m.score}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Finished({ view }: { view: PartyView }) {
  const { t } = useApp();
  const P = t.party;
  const top = view.members.filter((m) => m.rank === 1);
  return (
    <div className="space-y-8" data-testid="party-finished">
      <section className="tile px-5 py-8 text-center">
        <p className="text-xs font-bold uppercase tracking-[0.2em] opacity-60">{t.results.title}</p>
        <motion.p initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="mt-2 text-4xl font-extrabold">
          🏆 {top.map((m) => m.name).join(" · ")}
        </motion.p>
        <p className="mt-1 font-heading text-2xl tabular-nums">{top[0]?.score ?? 0}</p>
      </section>
      <Standings title={P.final} members={view.members} />
      <section className="space-y-6">
        <h2 className="text-xl font-extrabold">{P.recap}</h2>
        {view.history.map((r) => (
          <RevealCard key={r.index} reveal={r} total={view.totalRounds} />
        ))}
      </section>
      <Link href="/party" className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-primary font-bold text-primary-foreground" data-testid="party-new">
        {P.newGame}
      </Link>
    </div>
  );
}
