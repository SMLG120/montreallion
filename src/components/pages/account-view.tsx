"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Check, Loader2, LogOut, Mail } from "lucide-react";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { ClimberFigure } from "@/components/game/climber-figure";
import { LookEditor } from "@/components/game/look-editor";
import { refreshAccount, setAccount, storedGuestLook, useAccount, useLook, type Me } from "@/lib/client/account";
import { ACHIEVEMENTS } from "@/lib/game/profile";

export function AccountView({ notice }: { notice: "link" | "welcome" | null }) {
  const { t } = useApp();
  const ta = t.account;
  const account = useAccount();

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-extrabold">{ta.title}</h1>
      {notice === "link" && <p className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm" role="alert">{ta.linkFailed}</p>}
      {account.status === "loading" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> …
        </p>
      )}
      {account.status === "unavailable" && <p className="rounded-2xl border border-border bg-card text-card-foreground px-4 py-4 text-sm">{ta.unavailable}</p>}
      {account.status === "guest" && <SignIn />}
      {account.status === "signed-in" && <Profile me={account.me} welcome={notice === "welcome"} />}
    </div>
  );
}

function SignIn() {
  const { t } = useApp();
  const ta = t.account;
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error" | "bad" | "rate">("idle");
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setState("bad");
    setState("sending");
    const r = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }).catch(() => null);
    setState(r?.ok ? "sent" : r?.status === 429 ? "rate" : r?.status === 400 ? "bad" : "error");
  };
  return (
    <section className="rounded-2xl border border-border bg-card text-card-foreground space-y-4 px-5 py-6">
      <h2 className="text-xl font-bold">{ta.signInTitle}</h2>
      <p className="text-sm text-muted-foreground">{ta.signInBody}</p>
      {state === "sent" ? (
        <p className="flex items-start gap-2 rounded-lg border border-line-green/50 bg-line-green/10 px-3 py-3 text-sm" role="status" data-testid="login-sent">
          <Mail className="mt-0.5 size-4 shrink-0" aria-hidden /> {ta.sent(email.trim())}
        </p>
      ) : (
        <form onSubmit={send} className="flex flex-col gap-2 sm:flex-row" noValidate>
          <label className="flex-1">
            <span className="sr-only">{ta.email}</span>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={ta.email}
              aria-invalid={state === "bad"}
              aria-describedby="login-msg"
              className="h-11 w-full rounded-xl border border-border bg-muted/40 px-3"
              data-testid="login-email"
            />
          </label>
          <Button type="submit" className="h-11 rounded-xl font-bold" disabled={state === "sending"} data-testid="login-send">
            {state === "sending" ? <Loader2 className="animate-spin" /> : <Mail />}
            {state === "sending" ? ta.sending : ta.send}
          </Button>
        </form>
      )}
      <p id="login-msg" className="min-h-5 text-sm text-destructive" role="alert">
        {state === "bad" ? ta.badEmail : state === "rate" ? ta.rateLimited : state === "error" ? ta.error : ""}
      </p>
      <p className="text-xs text-muted-foreground">{ta.guestNote}</p>
    </section>
  );
}

function Profile({ me, welcome }: { me: Me; welcome: boolean }) {
  const { t, locale } = useApp();
  const ta = t.account;
  const { look, allowed, save } = useLook();
  const [name, setName] = useState(me.displayName ?? "");
  const [nameState, setNameState] = useState<"idle" | "saving" | "saved" | string>("idle");
  const carried = useRef(false);

  // First sign-in: carry the guest climber from this device into the new account (guest items are always allowed).
  useEffect(() => {
    if (!me.fresh || carried.current) return;
    carried.current = true;
    const guest = storedGuestLook();
    if (guest) void save(guest);
  }, [me.fresh, save]);

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    setNameState("saving");
    const r = await fetch("/api/me", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: name }) }).catch(() => null);
    if (!r) return setNameState("offline");
    if (r.ok) {
      setAccount({ status: "signed-in", me: ((await r.json()) as { me: Me }).me });
      setNameState("saved");
    } else setNameState(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "error");
  };

  const signOut = async () => {
    const r = await fetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    if (r) await refreshAccount();
  };

  const s = me.stats;
  const fmt = (n: number) => n.toLocaleString(locale === "fr" ? "fr-CA" : "en-CA");
  const date = (ms: number) => new Date(ms).toLocaleDateString(locale === "fr" ? "fr-CA" : "en-CA", { month: "short", day: "numeric" });

  return (
    <div className="space-y-6" data-testid="profile">
      <section className="rounded-2xl border border-border bg-card text-card-foreground flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <p className="text-sm" data-testid="signed-in-as">{ta.signedInAs(me.email)}</p>
        <Button variant="outline" className="h-11 rounded-xl" onClick={signOut} data-testid="logout">
          <LogOut /> {ta.signOut}
        </Button>
      </section>

      <section className="rounded-2xl border border-border bg-card text-card-foreground space-y-3 px-5 py-5">
        <form onSubmit={saveName} className="space-y-2">
          <label htmlFor="display-name" className="block text-sm font-bold">{ta.displayName}</label>
          <div className="flex gap-2">
            <input
              id="display-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameState("idle");
              }}
              maxLength={20}
              className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-muted/40 px-3"
              aria-describedby="name-hint name-msg"
              data-testid="profile-name"
            />
            <Button type="submit" className="h-11 rounded-xl font-bold" disabled={nameState === "saving"} data-testid="profile-name-save">
              {nameState === "saved" ? <Check /> : null}
              {nameState === "saved" ? ta.saved : ta.save}
            </Button>
          </div>
          <p id="name-hint" className="text-xs text-muted-foreground">{ta.displayNameHint}</p>
          <p id="name-msg" className="min-h-4 text-xs text-destructive" role="alert">
            {nameState === "offline" ? t.status.offline : nameState !== "idle" && nameState !== "saving" && nameState !== "saved" ? (ta.nameErrors[nameState] ?? ta.error) : ""}
          </p>
        </form>
      </section>

      <section className="rounded-2xl border border-border bg-card text-card-foreground grid gap-5 px-5 py-5 sm:grid-cols-[12rem_1fr]">
        <h2 className="text-lg font-bold sm:col-span-2">{ta.character}</h2>
        <div className="relative self-start overflow-hidden rounded-xl bg-[linear-gradient(#0d1530,#1b3a52_60%,#1e5a43)] sm:sticky sm:top-20">
          <svg viewBox="-40 -60 80 72" className="mx-auto block aspect-[80/72] w-full max-w-56" role="img" aria-label={ta.character} data-testid="avatar-preview" data-look={JSON.stringify(look)}>
            {[[-30, -50], [-12, -44], [22, -52], [32, -36], [-34, -26]].map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r={0.7} fill="#fff" opacity={0.6} />
            ))}
            <path d="M-44 12 L-44 2 Q-10 -6 0 -6 Q14 -6 44 0 L44 12Z" fill="#26734f" />
            <path d="M-14 1 h28 l-3 -4 h-22z" fill="#c9b48a" opacity={0.9} />
            <path d="M-32 -2 l5 -12 l5 12z M26 -1 l4 -10 l4 10z" fill="#2f8a5f" />
            <ClimberFigure look={look} />
          </svg>
        </div>
        <LookEditor look={look} allowed={allowed} onChange={(l) => void save(l)} />
      </section>

      <section className="rounded-2xl border border-border bg-card text-card-foreground space-y-4 px-5 py-5">
        <h2 className="text-lg font-bold">{ta.stats}</h2>
        {welcome && <p className="sr-only" role="status">{ta.signedInAs(me.email)}</p>}
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3" data-testid="stats">
          <Stat label={ta.rides} value={fmt(s.rides)} testid="stat-rides" />
          <Stat label={ta.bestDaily} value={s.bestDaily === null ? "—" : fmt(s.bestDaily)} />
          <Stat label={ta.bestUnlimited} value={s.bestUnlimited === null ? "—" : fmt(s.bestUnlimited)} />
          <Stat label={ta.streak} value={`${fmt(s.streak)}`} sub={ta.bestStreak(s.bestStreak)} />
          <Stat label={ta.climbed} value={fmt(s.totalSteps)} />
          <Stat label={ta.summits} value={fmt(s.summits)} />
        </dl>
        <div>
          <h3 className="mb-2 text-sm font-bold">{ta.achievements}</h3>
          <ul className="flex flex-wrap gap-2" data-testid="achievements">
            {ACHIEVEMENTS.map((a) => {
              const got = s.achievements.includes(a);
              return (
                <li key={a} className={`rounded-full border px-3 py-1 text-xs font-semibold ${got ? "border-line-yellow bg-line-yellow/15" : "border-border opacity-50"}`} data-got={got ? "1" : "0"}>
                  {ta.ach[a]}
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-bold">{ta.recent}</h3>
          {s.recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">{ta.none}</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {s.recent.map((r) => (
                <li key={r.id}>
                  <Link href={`/results/${r.id}`} className="flex min-h-11 items-center justify-between gap-3 hover:underline">
                    <span>{r.mode === "daily" ? t.results.daily(r.dateKey ?? "") : t.results.unlimited} · {date(r.finishedAt)}</span>
                    <span className="font-bold tabular-nums">{fmt(r.total)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, sub, testid }: { label: string; value: string; sub?: string; testid?: string }) {
  return (
    <div className="rounded-xl border border-border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-heading text-xl font-extrabold tabular-nums" data-testid={testid}>
        {value}
        {sub && <span className="ml-1 text-xs font-normal text-muted-foreground">{sub}</span>}
      </dd>
    </div>
  );
}
