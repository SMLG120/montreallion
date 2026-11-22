import "server-only";
import { randomUUID } from "node:crypto";
import { getBank, toPublic, type Bank } from "./bank";
import { dailyQuestions, dateKey, pickQuestions, QUESTIONS_PER_GAME } from "./daily";
import { matchAnswer } from "./match";
import { rarityTable, tierFor, type Rarity, type RarityBasis } from "./scoring";
import { defaultStore, type DailyChallenge, type DayCounts, type FrozenScores, type SessionStore } from "./store";
import type { CategoryId, Localized, PublicQuestion, Tier } from "./types";

export const ANSWER_MS = 25_000;
/** Network grace so a submit sent at 0.0s is not rejected by latency. */
export const GRACE_MS = 1_500;
/** Unlimited avoids questions from the player's last N sessions while enough fresh ones exist. */
export const RECENT_SESSIONS = 4;
/** A category needs this many approved questions to be offered as an Unlimited filter. */
export const MIN_CATEGORY_QUESTIONS = 3;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type Mode = "daily" | "unlimited";

export type Submission = {
  questionId: string;
  input: string;
  status: "correct" | "incorrect" | "expired";
  /** Answer slug within the question. */
  answerId: string | null;
  matchedBy: "exact" | "fuzzy" | null;
  score: number;
  tier: Tier | null;
  share: number | null;
  /** Which rarity basis produced the score (null for misses). */
  basis: RarityBasis | null;
  /** Distinct players behind an observed score. */
  sample: number | null;
  elapsedMs: number;
};

export type Session = {
  id: string;
  playerId: string;
  mode: Mode;
  dateKey: string | null;
  rarityModel: string;
  questionIds: string[];
  /** Index of the question currently being played (== length when finished). */
  index: number;
  servedAt: number | null;
  submissions: Submission[];
  createdAt: number;
  finishedAt: number | null;
  /** Ranked daily sessions score against the challenge's frozen snapshot. */
  frozenScores: FrozenScores | null;
};

export class GameError extends Error {
  constructor(
    public code: "not_found" | "forbidden" | "out_of_order" | "not_served" | "finished" | "unavailable",
    message?: string,
  ) {
    super(message ?? code);
  }
}

type Deps = { store?: SessionStore; now: () => number; random: () => number; bank?: () => Promise<Bank> };

/** Live scores for a question under the bank's current statistics. */
function liveTable(bank: Bank, questionId: string): Record<string, Rarity> {
  return rarityTable(bank.get(questionId), bank.counts(questionId));
}

/** Score lookup that honours a frozen daily snapshot when present. */
export function scoreFor(bank: Bank, frozen: FrozenScores | null, questionId: string, slug: string): Rarity {
  const f = frozen?.[questionId]?.[slug];
  if (f) return { score: f.score, share: f.share, tier: tierFor(f.score), basis: f.basis ?? "estimated", n: f.n ?? 0 };
  const r = liveTable(bank, questionId)[slug];
  if (!r) throw new Error(`Unknown answer ${slug} for ${questionId}`);
  return r;
}

/** Snapshot of every answer's score, taken once per daily so all players are scored by the same model. */
export function freezeScores(bank: Bank, questionIds: string[]): FrozenScores {
  const out: FrozenScores = {};
  for (const qid of questionIds) {
    out[qid] = Object.fromEntries(
      Object.entries(liveTable(bank, qid)).map(([slug, r]) => [slug, { score: r.score, share: r.share, basis: r.basis, n: r.n }]),
    );
  }
  return out;
}

export function createEngine(deps: Partial<Deps> = {}) {
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const loadBank = deps.bank ?? getBank;
  const store = async () => deps.store ?? defaultStore();

  const expiredSub = (questionId: string, input: string, elapsedMs: number): Submission => ({
    questionId,
    input,
    status: "expired",
    answerId: null,
    matchedBy: null,
    score: 0,
    tier: null,
    share: null,
    basis: null,
    sample: null,
    elapsedMs,
  });

  function advance(s: Session) {
    s.index += 1;
    s.servedAt = null;
    if (s.index >= s.questionIds.length) s.finishedAt = now();
  }

  function own(s: Session, playerId: string) {
    if (s.playerId !== playerId) throw new GameError("forbidden");
  }

  async function pickUnlimited(st: SessionStore, bank: Bank, playerId: string, category?: CategoryId): Promise<string[]> {
    const pool = category ? bank.questions.filter((q) => q.category === category) : bank.questions;
    if (pool.length < (category ? MIN_CATEGORY_QUESTIONS : 1)) throw new GameError("unavailable");
    const count = Math.min(QUESTIONS_PER_GAME, pool.length);
    const recent = new Set(await st.recentQuestionIds(playerId, RECENT_SESSIONS));
    const fresh = pool.filter((q) => !recent.has(q.id));
    const picked = pickQuestions(fresh, random, count);
    if (picked.length < count) {
      const used = new Set(picked.map((q) => q.id));
      picked.push(...pickQuestions(pool.filter((q) => !used.has(q.id)), random, count - picked.length));
    }
    return picked.map((q) => q.id);
  }

  return {
    async start(playerId: string, mode: Mode, opts: { category?: CategoryId } = {}): Promise<Session> {
      const [st, bank] = await Promise.all([store(), loadBank()]);
      const key = dateKey(new Date(now()));
      await st.ensurePlayer(playerId);

      let daily: DailyChallenge | null = null;
      if (mode === "daily") {
        const existing = await st.findDaily(playerId, key);
        if (existing) return existing;
        daily = await st.getOrCreateDaily(key, () => {
          const ids = dailyQuestions(bank.questions, key).map((q) => q.id);
          return { dateKey: key, questionIds: ids, rarityModel: bank.rarityModel, bankVersion: bank.version, scores: freezeScores(bank, ids) };
        });
      }
      const questionIds = daily ? daily.questionIds : await pickUnlimited(st, bank, playerId, opts.category);
      return st.createSession({
        id: randomUUID(),
        playerId,
        mode,
        dateKey: daily ? key : null,
        rarityModel: daily ? daily.rarityModel : bank.rarityModel,
        questionIds,
        index: 0,
        servedAt: null,
        submissions: [],
        createdAt: now(),
        finishedAt: null,
        frozenScores: daily ? daily.scores : null,
      });
    },

    /** Serves the current question and starts its timer. Idempotent: re-serving never resets the clock. */
    async serve(id: string, playerId: string): Promise<{ session: Session; question: PublicQuestion | null; deadline: number | null }> {
      if (!UUID_RE.test(id)) throw new GameError("not_found");
      const [st, bank] = await Promise.all([store(), loadBank()]);
      const out = await st.mutate(id, (s) => {
        own(s, playerId);
        // Abandoned question past its deadline ⇒ expired, then move on.
        if (s.servedAt !== null && s.index < s.questionIds.length && now() > s.servedAt + ANSWER_MS + GRACE_MS) {
          s.submissions.push(expiredSub(s.questionIds[s.index], "", ANSWER_MS));
          advance(s);
        }
        if (s.index >= s.questionIds.length) return null;
        if (s.servedAt === null) s.servedAt = now();
        return { question: toPublic(bank.get(s.questionIds[s.index]), s.index), deadline: s.servedAt + ANSWER_MS };
      });
      if (!out) throw new GameError("not_found");
      return { session: out.session, question: out.result?.question ?? null, deadline: out.result?.deadline ?? null };
    },

    async submit(
      id: string,
      playerId: string,
      index: number,
      input: string,
    ): Promise<{ session: Session; result: Submission | { status: "retry" } }> {
      if (!UUID_RE.test(id)) throw new GameError("not_found");
      const [st, bank] = await Promise.all([store(), loadBank()]);
      const out = await st.mutate(id, (s): Submission | { status: "retry" } => {
        own(s, playerId);
        if (s.finishedAt !== null) throw new GameError("finished");
        if (index !== s.index) throw new GameError("out_of_order");
        if (s.servedAt === null) throw new GameError("not_served");

        const q = bank.get(s.questionIds[s.index]);
        const elapsed = now() - s.servedAt;
        const trimmed = input.trim().slice(0, 120);

        let sub: Submission;
        if (elapsed > ANSWER_MS + GRACE_MS || !trimmed) {
          sub = expiredSub(q.id, trimmed, Math.min(elapsed, ANSWER_MS));
        } else {
          const m = matchAnswer(q, trimmed);
          if (m.kind === "ambiguous") return { status: "retry" };
          if (m.kind === "match") {
            const r = scoreFor(bank, s.frozenScores, q.id, m.answerId);
            sub = {
              questionId: q.id,
              input: trimmed,
              status: "correct",
              answerId: m.answerId,
              matchedBy: m.by,
              score: r.score,
              tier: r.tier,
              share: r.share,
              basis: r.basis,
              sample: r.basis === "observed" ? r.n : null,
              elapsedMs: elapsed,
            };
          } else {
            sub = { questionId: q.id, input: trimmed, status: "incorrect", answerId: null, matchedBy: null, score: 0, tier: null, share: null, basis: null, sample: null, elapsedMs: elapsed };
          }
        }
        s.submissions.push(sub);
        advance(s);
        return sub;
      });
      if (!out) throw new GameError("not_found");
      return out;
    },

    /** Read-only lookup without ownership check; callers must only expose finished sessions. */
    async get(id: string): Promise<Session | null> {
      if (!UUID_RE.test(id)) return null;
      return (await store()).get(id);
    },
  };
}

export const engine = createEngine();

/** What players see after answering: the matched answer plus a few examples, never the whole catalog mid-game. */
export function revealFor(bank: Bank, frozen: FrozenScores | null, questionId: string, answerId: string | null) {
  const q = bank.get(questionId);
  const score = (slug: string) => scoreFor(bank, frozen, q.id, slug).score;
  // Most common = lowest score under the same model the player was scored with.
  const sorted = [...q.answers].sort((a, b) => score(a.id) - score(b.id) || b.est - a.est || a.id.localeCompare(b.id));
  const label = (a: (typeof q.answers)[number]): Localized => ({ en: a.en, fr: a.fr ?? a.en });
  const entry = (a: (typeof q.answers)[number]) => ({ ...label(a), score: score(a.id) });
  const matched = answerId ? q.answers.find((a) => a.id === answerId) : undefined;
  return {
    matched: matched ? label(matched) : null,
    popular: sorted.slice(0, 3).map(entry),
    rarest: sorted.slice(-2).reverse().map(entry),
    total: q.answers.length,
  };
}

/** `day` (daily sessions only): how the day's players answered, for the "x of N players" line. */
export function summarize(bank: Bank, s: Session, day?: Record<string, DayCounts> | null) {
  return {
    id: s.id,
    mode: s.mode,
    dateKey: s.dateKey,
    rarityModel: s.rarityModel,
    finished: s.finishedAt !== null,
    total: s.submissions.reduce((t, x) => t + x.score, 0),
    max: s.questionIds.length * 100,
    rounds: s.submissions.map((x, i) => {
      const q = bank.get(x.questionId);
      return {
        index: i,
        prompt: q.prompt,
        category: q.category,
        input: x.input,
        status: x.status,
        score: x.score,
        tier: x.tier,
        share: x.share,
        basis: x.basis,
        sample: x.sample,
        today: day?.[x.questionId] ? { players: day[x.questionId].players, same: x.answerId ? (day[x.questionId].bySlug[x.answerId] ?? 0) : 0 } : null,
        reveal: revealFor(bank, s.frozenScores, x.questionId, x.answerId),
      };
    }),
  };
}
