"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { CATEGORY_LABELS } from "@/lib/i18n/dict";
import type { CategoryId } from "@/lib/game/types";

const ROUNDS = [3, 5, 7, 10];
const field = "h-11 w-full rounded-xl border border-border bg-background px-3";

export function PartyHome({ categories, initialCode }: { categories: CategoryId[]; initialCode: string }) {
  const { t, locale } = useApp();
  const P = t.party;
  const router = useRouter();
  const [name, setName] = useState("");
  const [rounds, setRounds] = useState(5);
  const [category, setCategory] = useState<string>("");
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefill with the leaderboard name, if any.
  useEffect(() => {
    fetch("/api/player")
      .then((r) => r.json())
      .then((d) => d.displayName && setName((n) => n || d.displayName))
      .catch(() => {});
  }, []);

  const fail = (e: string | undefined) => setError(P.errors[e ?? "generic"] ?? P.errors.generic);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch("/api/party", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, rounds, category: category || null }),
    }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (r?.ok) router.push(`/party/${d.code}`);
    else fail(d.error);
  };

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/party/${encodeURIComponent(c)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "join", name }),
    }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (r?.ok) router.push(`/party/${c}`);
    else fail(d.error);
  };

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="flex items-center gap-2 text-4xl font-extrabold">
          <Users className="size-8 text-[var(--line-blue)]" aria-hidden /> {P.title}
        </h1>
        <p className="text-muted-foreground">{P.intro}</p>
      </header>

      <label className="block space-y-1 font-bold">
        <span>{P.yourName}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoComplete="nickname" className={field} data-testid="party-name" />
      </label>
      {error && (
        <p className="text-sm text-destructive" role="alert" data-testid="party-error">
          {error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <form onSubmit={create} className="tile space-y-3 p-5">
          <h2 className="text-xl font-extrabold">{P.create}</h2>
          <label className="block space-y-1 text-sm font-bold">
            <span>{P.rounds}</span>
            <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))} className={field} data-testid="party-rounds">
              {ROUNDS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-sm font-bold">
            <span>{P.category}</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={field}>
              <option value="">{P.anyCategory}</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c][locale]}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={busy} className="h-11 w-full rounded-xl font-bold" data-testid="party-create">
            {P.create}
          </Button>
        </form>

        <form onSubmit={join} className="tile space-y-3 p-5">
          <h2 className="text-xl font-extrabold">{P.join}</h2>
          <label className="block space-y-1 text-sm font-bold">
            <span>{P.code}</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5))}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              placeholder="ABCDE"
              className={`${field} font-mono text-2xl tracking-[0.3em]`}
              data-testid="party-code"
            />
          </label>
          <Button type="submit" variant="outline" disabled={busy || code.length !== 5} className="h-11 w-full rounded-xl font-bold" data-testid="party-join">
            {P.joinCta}
          </Button>
        </form>
      </div>
    </div>
  );
}
