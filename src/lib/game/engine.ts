import "server-only";
import { randomUUID } from "node:crypto";
import { getBank, toPublic, type Bank } from "./bank";
import { dailyQuestions, dateKey, pickQuestions, QUESTIONS_PER_GAME } from "./daily";
import { checkAnswer, matchAnswer } from "./match";
import { normalizeAnswer } from "./normalize";
import { rarityTable, tierFor, type Rarity, type RarityBasis } from "./scoring";
import { defaultStore, type DailyChallenge, type DayCounts, type FrozenScores, type SessionStore } from "./store";
import type { CategoryId, Localized, PublicQuestion, Tier } from "./types";

export const ANSWER_MS = 25_000;
/** Network grace so a submit sent at 0.0s is not rejected by latency. */
export const GRACE_MS = 1_500;
/** A pre-check made before the deadline may still be confirmed this long after the check (bounded, small). */
export const CONFIRM_GRACE_MS = 6_000;
/** Distinct double-checks per question: bounds how many guesses can be tested before committing. */
export const MAX_CHECKS = 3;
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

/** Server-side record of the latest double-check for the current question (never sent to clients). */
export type Precheck = {
  index: number;
  /** Distinct checks used on this question. */
  checks: number;
  /** Server time of the latest check (ms). */
  at: number;
  /** Normalized input that was checked; confirming requires the same key. */
  key: string;
  kind: "match" | "possible" | "vague" | "none";
  /** Candidate answer slugs, in the order shown to the player. */
  answerIds: string[];
  by: "exact" | "fuzzy" | null;
};

export type CheckView = {
  status: "match" | "possible" | "vague" | "none" | "limit" | "expired";
  /** Labels only: no ids, scores or rarity before the final submission. */
  candidates: Localized[];
  checksLeft: number;
  /** Latest server time at which this check can still be confirmed (ms). */
  confirmBy: number | null;
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
  /** Latest double-check for the current question, if any. */
  precheck?: Precheck | null;
};

/** Pre-check that belongs to the session's current question, if any. */
function currentCheck(s: Session): Precheck | null {
  return s.precheck && s.precheck.index === s.index ? s.precheck : null;
}

/** When the current question stops accepting answers: base deadline, extended only by a timely pre-check. */
export function closesAt(s: Session): number | null {
  if (s.servedAt === null) return null;
  const base = s.servedAt + ANSWER_MS + GRACE_MS;
  const pc = currentCheck(s);
  return pc ? Math.max(base, pc.at + CONFIRM_GRACE_MS) : base;
}

export class GameError extends Error {
  constructor(
    public code: "not_found" | "forbidden" | "out_of_order" | "not_served" | "finished" | "unavailable" | "bad_choice",
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
    s.precheck = null;
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
        precheck: null,
      });
    },

    /** Serves the current question and starts its timer. Idempotent: re-serving never resets the clock. */
    async serve(id: string, playerId: string): Promise<{ session: Session; question: PublicQuestion | null; deadline: number | null }> {
      if (!UUID_RE.test(id)) throw new GameError("not_found");
      const [st, bank] = await Promise.all([store(), loadBank()]);
      const out = await st.mutate(id, (s) => {
        own(s, playerId);
        // Abandoned question past its deadline ⇒ expired, then move on.
        if (s.servedAt !== null && s.index < s.questionIds.length && now() > closesAt(s)!) {
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
      /** Index into the latest pre-check's candidates: the entity the player confirmed. */
      choice?: number,
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
        const pc = currentCheck(s);
        // The final input must be exactly what was double-checked (same normalized key) to use its result or grace.
        const confirms = pc !== null && trimmed !== "" && pc.key === normalizeAnswer(trimmed);
        if (choice !== undefined && (!confirms || !Number.isInteger(choice) || choice < 0 || choice >= pc!.answerIds.length)) {
          throw new GameError("bad_choice");
        }
        const inTime = elapsed <= ANSWER_MS + GRACE_MS || (confirms && now() <= pc!.at + CONFIRM_GRACE_MS);
        const timed = Math.min(elapsed, ANSWER_MS + GRACE_MS);

        let m: ReturnType<typeof matchAnswer>;
        if (choice !== undefined) m = { kind: "match", answerId: pc!.answerIds[choice], by: pc!.by ?? "exact" };
        else if (confirms && pc!.kind === "match") m = { kind: "match", answerId: pc!.answerIds[0], by: "exact" };
        else if (confirms && pc!.kind === "vague") m = { kind: "ambiguous" };
        // Checked and the player declined every suggestion: never swap in a different entity.
        else if (confirms) m = { kind: "none" };
        else m = matchAnswer(q, trimmed); // unchecked (e.g. timer ran out before a check)

        let sub: Submission;
        if (!inTime || !trimmed) {
          sub = expiredSub(q.id, trimmed, Math.min(elapsed, ANSWER_MS));
        } else {
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
              elapsedMs: timed,
            };
          } else {
            sub = { questionId: q.id, input: trimmed, status: "incorrect", answerId: null, matchedBy: null, score: 0, tier: null, share: null, basis: null, sample: null, elapsedMs: timed };
          }
        }
        s.submissions.push(sub);
        advance(s);
        return sub;
      });
      if (!out) throw new GameError("not_found");
      return out;
    },

    /**
     * Double-check without consuming the question: reports MATCH / POSSIBLE / NOT RECOGNIZED
     * with candidate labels only (no ids, scores or rarity). Re-checking the same input is free;
     * each distinct input uses one of MAX_CHECKS per question.
     */
    async check(id: string, playerId: string, index: number, input: string): Promise<{ session: Session; view: CheckView }> {
      if (!UUID_RE.test(id)) throw new GameError("not_found");
      const [st, bank] = await Promise.all([store(), loadBank()]);
      const out = await st.mutate(id, (s): CheckView => {
        own(s, playerId);
        if (s.finishedAt !== null) throw new GameError("finished");
        if (index !== s.index) throw new GameError("out_of_order");
        if (s.servedAt === null) throw new GameError("not_served");
        const q = bank.get(s.questionIds[s.index]);
        const label = (slug: string): Localized => {
          const a = q.answers.find((x) => x.id === slug)!;
          return { en: a.en, fr: a.fr ?? a.en };
        };
        const pc = currentCheck(s);
        const used = pc?.checks ?? 0;
        const view = (p: Precheck, status: CheckView["status"] = p.kind): CheckView => ({
          status,
          candidates: p.answerIds.map(label),
          checksLeft: MAX_CHECKS - p.checks,
          confirmBy: Math.max(s.servedAt! + ANSWER_MS, p.at + CONFIRM_GRACE_MS),
        });
        if (now() - s.servedAt > ANSWER_MS + GRACE_MS) return { status: "expired", candidates: [], checksLeft: MAX_CHECKS - used, confirmBy: null };
        const trimmed = input.trim().slice(0, 120);
        const key = normalizeAnswer(trimmed);
        if (!key) return { status: "none", candidates: [], checksLeft: MAX_CHECKS - used, confirmBy: null };
        if (pc && pc.key === key) return view(pc); // same input again: idempotent, free
        if (used >= MAX_CHECKS) return { status: "limit", candidates: [], checksLeft: 0, confirmBy: null };
        const r = checkAnswer(q, trimmed);
        const ids = r.kind === "match" || r.kind === "possible" ? r.answerIds : [];
        s.precheck = { index: s.index, checks: used + 1, at: now(), key, kind: r.kind, answerIds: ids, by: ids.length ? (r as { by: "exact" | "fuzzy" }).by : null };
        return view(s.precheck);
      });
      if (!out) throw new GameError("not_found");
      return { session: out.session, view: out.result };
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
