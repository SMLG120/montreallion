import type { Session } from "./engine";
import type { RideRow } from "./profile";

import type { RarityBasis } from "./scoring";

/** qid → slug → frozen score. `basis`/`n` are absent in snapshots made before observed-v1 (treated as estimated). */
export type FrozenScores = Record<string, Record<string, { score: number; share: number; basis?: RarityBasis; n?: number }>>;

/** Per question on one day: players who answered it (any outcome) and how many gave each answer. */
export type DayCounts = { players: number; bySlug: Record<string, number> };

export type BoardEntry = { rank: number; name: string | null; tag: string; score: number; elapsedMs: number; you: boolean };
export type Board = { dateKey: string; players: number; top: BoardEntry[]; you: BoardEntry | null };

/** Stable, non-reversible 4-digit tag for anonymous players (never expose player ids). */
export function anonTag(playerId: string): string {
  let h = 0x811c9dc5;
  for (const ch of `ml-tag:${playerId}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return String(1000 + (h % 9000));
}

/** An account's own profile row (owner-only; see migration 20261125000001). */
export type AccountProfile = { displayName: string | null; appearance: Record<string, unknown> };
export type ProfilePatch = { displayName?: string | null; appearance?: Record<string, string> };

export type DailyChallenge = {
  dateKey: string;
  questionIds: string[];
  rarityModel: string;
  bankVersion: string;
  scores: FrozenScores;
};

/**
 * Persistence boundary. `mutate` must run `fn` against the latest committed
 * session state with exclusive access (row lock / mutex) and persist the result
 * atomically: either everything `fn` changed is saved, or nothing is.
 */
export interface SessionStore {
  readonly kind: "memory" | "postgres";
  get(id: string): Promise<Session | null>;
  ensurePlayer(playerId: string): Promise<void>;
  /** Returns the frozen daily challenge for `dateKey`, creating it with `make()` if absent (first writer wins). */
  getOrCreateDaily(dateKey: string, make: () => DailyChallenge): Promise<DailyChallenge>;
  /** Inserts a session; for daily mode, returns the player's existing session for that day instead if one exists. */
  createSession(s: Session): Promise<Session>;
  findDaily(playerId: string, dateKey: string): Promise<Session | null>;
  mutate<T>(id: string, fn: (s: Session) => T): Promise<{ session: Session; result: T } | null>;
  /** Ranked finished daily sessions: score desc, then total answer time asc. */
  leaderboard(dateKey: string, playerId: string | null, limit: number): Promise<Board>;
  /** Per question, how many of the day's daily players gave each answer (finished or not). */
  dailyCounts(dateKey: string): Promise<Record<string, DayCounts>>;
  getDisplayName(playerId: string): Promise<string | null>;
  /** Question ids from the player's most recent `sessions` sessions (any mode), newest first. */
  recentQuestionIds(playerId: string, sessions: number): Promise<string[]>;
  setDisplayName(playerId: string, name: string | null): Promise<void>;
  /** Links a guest player to an account. A player already linked to another account is never moved (returns false). */
  linkAccount(userId: string, playerId: string): Promise<boolean>;
  /** The account's linked players, oldest link first (the first is the account's primary player). */
  accountPlayers(userId: string): Promise<string[]>;
  /** Finished rides of these players, newest first. */
  finishedRides(playerIds: string[], limit: number): Promise<RideRow[]>;
  /** The account's profile, read as that account (RLS on Postgres); null before the first save. */
  getProfile(userId: string): Promise<AccountProfile | null>;
  /** Creates or updates the account's own profile; only the fields present in the patch change. */
  saveProfile(userId: string, patch: ProfilePatch): Promise<AccountProfile>;
}

export const rideRow = (s: Session): RideRow => ({
  id: s.id,
  mode: s.mode,
  dateKey: s.dateKey,
  finishedAt: s.finishedAt!,
  total: scoreOf(s),
  tiers: s.submissions.map((x) => x.tier),
});

const elapsedOf = (s: Session) => s.submissions.reduce((t, x) => t + x.elapsedMs, 0);
const scoreOf = (s: Session) => s.submissions.reduce((t, x) => t + x.score, 0);

/** Shared ranking used by the memory store (Postgres does the same in SQL). */
export function rankBoard(
  dateKey: string,
  rows: { playerId: string; name: string | null; score: number; elapsedMs: number; finishedAt: number }[],
  playerId: string | null,
  limit: number,
): Board {
  const sorted = [...rows].sort((a, b) => b.score - a.score || a.elapsedMs - b.elapsedMs || a.finishedAt - b.finishedAt);
  let rank = 0;
  const entries = sorted.map((r, i) => {
    const prev = sorted[i - 1];
    if (!prev || prev.score !== r.score || prev.elapsedMs !== r.elapsedMs) rank = i + 1;
    return { rank, name: r.name, tag: anonTag(r.playerId), score: r.score, elapsedMs: r.elapsedMs, you: r.playerId === playerId };
  });
  return { dateKey, players: entries.length, top: entries.filter((e) => e.rank <= limit).slice(0, limit), you: entries.find((e) => e.you) ?? null };
}

const TTL_MS = 36 * 60 * 60 * 1000;

/** In-process store for local dev/tests. Not shared across instances; lost on restart. */
export function createMemoryStore(): SessionStore {
  const sessions = new Map<string, Session>();
  const daily = new Map<string, string>();
  const challenges = new Map<string, DailyChallenge>();
  const locks = new Map<string, Promise<unknown>>();
  const names = new Map<string, string>();
  const links = new Map<string, { userId: string; at: number }>();
  const profiles = new Map<string, AccountProfile>();

  const withLock = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const run = (locks.get(id) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    locks.set(id, tail);
    void tail.then(() => locks.get(id) === tail && locks.delete(id));
    return run;
  };

  const sweep = () => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.createdAt > TTL_MS) {
        sessions.delete(id);
        if (s.dateKey) daily.delete(`${s.playerId}:${s.dateKey}`);
      }
    }
  };

  return {
    kind: "memory",
    async get(id) {
      const s = sessions.get(id);
      return s ? structuredClone(s) : null;
    },
    async ensurePlayer() {},
    async getOrCreateDaily(dateKey, make) {
      if (!challenges.has(dateKey)) challenges.set(dateKey, make());
      return structuredClone(challenges.get(dateKey)!);
    },
    createSession(s) {
      return withLock(`create:${s.playerId}`, async () => {
        if (s.mode === "daily" && s.dateKey) {
          const existing = daily.get(`${s.playerId}:${s.dateKey}`);
          if (existing && sessions.has(existing)) return structuredClone(sessions.get(existing)!);
          daily.set(`${s.playerId}:${s.dateKey}`, s.id);
        }
        if (sessions.size > 5000) sweep();
        sessions.set(s.id, structuredClone(s));
        return structuredClone(s);
      });
    },
    async findDaily(playerId, dateKey) {
      const id = daily.get(`${playerId}:${dateKey}`);
      return id ? this.get(id) : null;
    },
    mutate(id, fn) {
      return withLock(id, async () => {
        const cur = sessions.get(id);
        if (!cur) return null;
        const draft = structuredClone(cur);
        const result = fn(draft); // throws ⇒ nothing saved
        sessions.set(id, structuredClone(draft));
        return { session: draft, result };
      });
    },
    async leaderboard(dateKey, playerId, limit) {
      const rows = [...sessions.values()]
        .filter((s) => s.mode === "daily" && s.dateKey === dateKey && s.finishedAt !== null)
        .map((s) => ({ playerId: s.playerId, name: names.get(s.playerId) ?? null, score: scoreOf(s), elapsedMs: elapsedOf(s), finishedAt: s.finishedAt! }));
      return rankBoard(dateKey, rows, playerId, limit);
    },
    async dailyCounts(dateKey) {
      const out: Record<string, DayCounts> = {};
      for (const s of sessions.values()) {
        if (s.mode !== "daily" || s.dateKey !== dateKey) continue;
        for (const x of s.submissions) {
          const c = (out[x.questionId] ??= { players: 0, bySlug: {} });
          c.players += 1; // every daily player answers each question at most once
          if (x.answerId) c.bySlug[x.answerId] = (c.bySlug[x.answerId] ?? 0) + 1;
        }
      }
      return out;
    },
    async getDisplayName(playerId) {
      return names.get(playerId) ?? null;
    },
    async recentQuestionIds(playerId, n) {
      return [...sessions.values()]
        .filter((s) => s.playerId === playerId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, n)
        .flatMap((s) => s.questionIds);
    },
    async setDisplayName(playerId, name) {
      if (name) names.set(playerId, name);
      else names.delete(playerId);
    },
    async linkAccount(userId, playerId) {
      const cur = links.get(playerId);
      if (cur) return cur.userId === userId;
      links.set(playerId, { userId, at: Date.now() + links.size / 1000 });
      return true;
    },
    async accountPlayers(userId) {
      return [...links.entries()].filter(([, l]) => l.userId === userId).sort((a, b) => a[1].at - b[1].at).map(([p]) => p);
    },
    async finishedRides(playerIds, limit) {
      const ids = new Set(playerIds);
      return [...sessions.values()]
        .filter((s) => ids.has(s.playerId) && s.finishedAt !== null)
        .sort((a, b) => b.finishedAt! - a.finishedAt!)
        .slice(0, limit)
        .map(rideRow);
    },
    async getProfile(userId) {
      const p = profiles.get(userId);
      return p ? { ...p, appearance: { ...p.appearance } } : null;
    },
    async saveProfile(userId, patch) {
      const cur = profiles.get(userId) ?? { displayName: null, appearance: {} };
      const next: AccountProfile = {
        displayName: patch.displayName !== undefined ? patch.displayName : cur.displayName,
        appearance: patch.appearance !== undefined ? { ...patch.appearance } : cur.appearance,
      };
      profiles.set(userId, next);
      return { ...next, appearance: { ...next.appearance } };
    },
  };
}

const g = globalThis as unknown as { __mlStore?: SessionStore };

/** Postgres when DATABASE_URL is set, otherwise the in-memory store. */
export async function defaultStore(): Promise<SessionStore> {
  if (g.__mlStore) return g.__mlStore;
  const { getSql } = await import("@/lib/server/db");
  const sql = getSql();
  if (sql) {
    const { createPostgresStore } = await import("./store-postgres");
    const { getBank } = await import("./bank");
    g.__mlStore = createPostgresStore(sql, getBank);
  } else {
    g.__mlStore = createMemoryStore();
  }
  return g.__mlStore;
}
