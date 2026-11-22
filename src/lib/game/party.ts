/**
 * Party mode: a pure, server-authoritative room state machine.
 *
 * Stores persist `RoomState` (Postgres: one jsonb row per room, row-locked per mutation);
 * every transition happens in these functions, so memory and Postgres behave identically.
 * Time-based transitions (deadline → reveal → next round) are applied lazily by `tick`
 * on any read or write; no background job is needed (works on serverless).
 */
import { toPublic, type Bank } from "./bank";
import { pickQuestions } from "./daily";
import { ANSWER_MS, freezeScores, GRACE_MS, revealFor, scoreFor } from "./engine";
import { matchAnswer } from "./match";
import type { FrozenScores } from "./store";
import type { CategoryId, Localized, PublicQuestion, Tier } from "./types";


export const PARTY_ROUNDS = [3, 5, 7, 10] as const;
export const MAX_MEMBERS = 12;
export const REVEAL_MS = 12_000;
/** A member who hasn't polled for this long is "away": rounds don't wait for them. */
export const ACTIVE_MS = 20_000;
/** Host role moves to the longest-present active member after this much host silence. */
export const HOST_TIMEOUT_MS = 30_000;
/** Rooms are forgotten after this much inactivity. */
export const ROOM_TTL_MS = 3 * 60 * 60 * 1000;
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
export const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;

export type Member = { id: string; name: string; joinedAt: number; lastSeen: number };
export type PartyAnswer = {
  input: string;
  status: "correct" | "incorrect" | "expired";
  answerId: string | null;
  score: number;
  tier: Tier | null;
  at: number;
};

export type RoomState = {
  code: string;
  createdAt: number;
  updatedAt: number;
  hostId: string;
  status: "lobby" | "playing" | "finished";
  settings: { rounds: number; category: CategoryId | null };
  members: Member[];
  questionIds: string[];
  frozen: FrozenScores | null;
  rarityModel: string | null;
  round: number;
  roundStartedAt: number | null;
  roundClosedAt: number | null;
  /** round index → member id → answer */
  answers: Record<number, Record<string, PartyAnswer>>;
  finishedAt: number | null;
};

export class PartyError extends Error {
  constructor(
    public code:
      | "not_found"
      | "not_member"
      | "not_host"
      | "started"
      | "full"
      | "name_taken"
      | "not_playing"
      | "wrong_round"
      | "closed"
      | "answered"
      | "too_few_questions"
      | "not_reveal",
  ) {
    super(code);
  }
}

export function makeCode(rand: () => number): string {
  let s = "";
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

const nameKey = (n: string) => n.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export function createRoom(code: string, hostId: string, hostName: string, settings: RoomState["settings"], now: number): RoomState {
  return {
    code,
    createdAt: now,
    updatedAt: now,
    hostId,
    status: "lobby",
    settings,
    members: [{ id: hostId, name: hostName, joinedAt: now, lastSeen: now }],
    questionIds: [],
    frozen: null,
    rarityModel: null,
    round: 0,
    roundStartedAt: null,
    roundClosedAt: null,
    answers: {},
    finishedAt: null,
  };
}

export const isExpired = (s: RoomState, now: number) => now - s.updatedAt > ROOM_TTL_MS;
const member = (s: RoomState, id: string) => s.members.find((m) => m.id === id);
const active = (m: Member, now: number) => now - m.lastSeen <= ACTIVE_MS;
const deadlineOf = (s: RoomState) => (s.roundStartedAt ?? 0) + ANSWER_MS;

/** Join (or rejoin: same player id keeps its seat and may rename while in the lobby). */
export function join(s: RoomState, playerId: string, name: string, now: number): void {
  const me = member(s, playerId);
  const clash = s.members.find((m) => m.id !== playerId && nameKey(m.name) === nameKey(name));
  if (me) {
    if (s.status === "lobby" && me.name !== name) {
      if (clash) throw new PartyError("name_taken");
      me.name = name;
    }
    me.lastSeen = now;
    return;
  }
  if (s.status !== "lobby") throw new PartyError("started");
  if (s.members.length >= MAX_MEMBERS) throw new PartyError("full");
  if (clash) throw new PartyError("name_taken");
  s.members.push({ id: playerId, name, joinedAt: now, lastSeen: now });
}

export function leave(s: RoomState, playerId: string, now: number): void {
  if (!member(s, playerId)) throw new PartyError("not_member");
  if (s.status === "lobby") s.members = s.members.filter((m) => m.id !== playerId);
  else member(s, playerId)!.lastSeen = 0; // keep their scores; they're "away"
  if (s.hostId === playerId) reassignHost(s, now, true);
}

function reassignHost(s: RoomState, now: number, force: boolean) {
  const host = member(s, s.hostId);
  if (!force && host && now - host.lastSeen <= HOST_TIMEOUT_MS) return false;
  const next = s.members.filter((m) => m.id !== s.hostId && active(m, now)).sort((a, b) => a.joinedAt - b.joinedAt)[0];
  if (!next) return false;
  s.hostId = next.id;
  return true;
}

export function start(s: RoomState, playerId: string, bank: Bank, rand: () => number, now: number): void {
  if (s.hostId !== playerId) throw new PartyError("not_host");
  if (s.status !== "lobby") throw new PartyError("started");
  const pool = s.settings.category ? bank.questions.filter((q) => q.category === s.settings.category) : bank.questions;
  if (pool.length < 3) throw new PartyError("too_few_questions");
  s.questionIds = pickQuestions(pool, rand, Math.min(s.settings.rounds, pool.length)).map((q) => q.id);
  // Freeze scoring for the whole room, like the daily line: everyone is scored by the same model.
  s.frozen = freezeScores(bank, s.questionIds);
  s.rarityModel = bank.rarityModel;
  s.status = "playing";
  s.round = 0;
  s.roundStartedAt = now;
  s.roundClosedAt = null;
  s.answers = { 0: {} };
}

function closeRound(s: RoomState, at: number) {
  const ans = (s.answers[s.round] ??= {});
  for (const m of s.members) {
    ans[m.id] ??= { input: "", status: "expired", answerId: null, score: 0, tier: null, at };
  }
  s.roundClosedAt = at;
}

function nextRound(s: RoomState, now: number) {
  if (s.round + 1 >= s.questionIds.length) {
    s.status = "finished";
    s.finishedAt = now;
    s.roundStartedAt = null;
    return;
  }
  s.round += 1;
  s.roundStartedAt = now;
  s.roundClosedAt = null;
  s.answers[s.round] = {};
}

/** Applies due time-based transitions. Returns true if anything changed. */
export function tick(s: RoomState, now: number): boolean {
  let changed = reassignHost(s, now, false);
  for (let guard = 0; guard < 4 && s.status === "playing"; guard++) {
    if (s.roundClosedAt === null && now > deadlineOf(s) + GRACE_MS) {
      closeRound(s, deadlineOf(s));
      changed = true;
    } else if (s.roundClosedAt !== null && now >= s.roundClosedAt + REVEAL_MS) {
      nextRound(s, now);
      changed = true;
    } else break;
  }
  return changed;
}

export function touch(s: RoomState, playerId: string, now: number): boolean {
  const m = member(s, playerId);
  if (!m) return false;
  const wasActive = active(m, now);
  m.lastSeen = now;
  return !wasActive;
}

/** Whether a member's lastSeen is stale enough to be worth persisting (limits writes from polling). */
export const needsTouch = (s: RoomState, playerId: string, now: number) => {
  const m = member(s, playerId);
  return !!m && now - m.lastSeen > ACTIVE_MS / 3;
};

export type SubmitResult = { status: "locked" } | { status: "retry" };

export function submit(s: RoomState, playerId: string, bank: Bank, round: number, raw: string, now: number): SubmitResult {
  if (!member(s, playerId)) throw new PartyError("not_member");
  if (s.status !== "playing") throw new PartyError("not_playing");
  if (round !== s.round) throw new PartyError("wrong_round");
  if (s.roundClosedAt !== null || now > deadlineOf(s) + GRACE_MS) throw new PartyError("closed");
  const ans = (s.answers[s.round] ??= {});
  if (ans[playerId]) throw new PartyError("answered");
  const q = bank.get(s.questionIds[s.round]);
  const input = raw.trim().slice(0, 120);
  let a: PartyAnswer;
  if (!input) a = { input, status: "expired", answerId: null, score: 0, tier: null, at: now };
  else {
    const m = matchAnswer(q, input);
    if (m.kind === "ambiguous") return { status: "retry" };
    if (m.kind === "match") {
      const r = scoreFor(bank, s.frozen, q.id, m.answerId);
      a = { input, status: "correct", answerId: m.answerId, score: r.score, tier: r.tier, at: now };
    } else a = { input, status: "incorrect", answerId: null, score: 0, tier: null, at: now };
  }
  ans[playerId] = a;
  // Close early once everyone still present has answered.
  if (s.members.filter((mm) => active(mm, now) || mm.id === playerId).every((mm) => ans[mm.id])) closeRound(s, now);
  return { status: "locked" };
}

/** Host skips the rest of the reveal. */
export function advance(s: RoomState, playerId: string, now: number): void {
  if (s.hostId !== playerId) throw new PartyError("not_host");
  if (s.status !== "playing" || s.roundClosedAt === null) throw new PartyError("not_reveal");
  nextRound(s, now);
}

/* ------------------------------------------------------------------ client view */

export type Standing = { name: string; score: number; rank: number; you: boolean; host: boolean; active: boolean; answered: boolean };
export type RoundReveal = {
  index: number;
  prompt: Localized;
  answers: { name: string; you: boolean; input: string; status: PartyAnswer["status"]; score: number; tier: Tier | null; matched: Localized | null; same: number }[];
  popular: (Localized & { score: number })[];
  rarest: (Localized & { score: number })[];
  total: number;
};

export type PartyView = {
  code: string;
  status: RoomState["status"];
  phase: "lobby" | "question" | "reveal" | "finished";
  settings: RoomState["settings"];
  you: { member: boolean; host: boolean; name: string | null; answered: boolean; input: string | null };
  hostName: string;
  members: Standing[];
  round: number;
  totalRounds: number;
  question: PublicQuestion | null;
  deadline: number | null;
  revealUntil: number | null;
  answeredCount: number;
  reveal: RoundReveal | null;
  history: RoundReveal[];
};

function revealRound(s: RoomState, bank: Bank, i: number, playerId: string): RoundReveal {
  const qid = s.questionIds[i];
  const q = bank.get(qid);
  const ans = s.answers[i] ?? {};
  const counts: Record<string, number> = {};
  for (const a of Object.values(ans)) if (a.answerId) counts[a.answerId] = (counts[a.answerId] ?? 0) + 1;
  const base = revealFor(bank, s.frozen, qid, null);
  return {
    index: i,
    prompt: q.prompt,
    answers: s.members
      .filter((m) => ans[m.id])
      .map((m) => {
        const a = ans[m.id];
        const matched = a.answerId ? q.answers.find((x) => x.id === a.answerId) : undefined;
        return {
          name: m.name,
          you: m.id === playerId,
          input: a.input,
          status: a.status,
          score: a.score,
          tier: a.tier,
          matched: matched ? { en: matched.en, fr: matched.fr ?? matched.en } : null,
          same: a.answerId ? counts[a.answerId] - 1 : 0,
        };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
    popular: base.popular,
    rarest: base.rarest,
    total: base.total,
  };
}

/** What one player may see. Never includes member ids, and never another player's answer before the round closes. */
export function view(s: RoomState, bank: Bank, playerId: string, now: number): PartyView {
  const me = member(s, playerId);
  const totals = new Map<string, number>();
  for (const [r, ans] of Object.entries(s.answers)) {
    if (Number(r) === s.round && s.roundClosedAt === null && s.status === "playing") continue; // live round hidden
    for (const [id, a] of Object.entries(ans)) totals.set(id, (totals.get(id) ?? 0) + a.score);
  }
  const cur = s.answers[s.round] ?? {};
  const sorted = [...s.members].sort((a, b) => (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0) || a.joinedAt - b.joinedAt);
  let rank = 0;
  const members: Standing[] = sorted.map((m, i) => {
    const sc = totals.get(m.id) ?? 0;
    if (i === 0 || sc !== (totals.get(sorted[i - 1].id) ?? 0)) rank = i + 1;
    return { name: m.name, score: sc, rank, you: m.id === playerId, host: m.id === s.hostId, active: active(m, now), answered: !!cur[m.id] };
  });

  const phase: PartyView["phase"] =
    s.status === "lobby" ? "lobby" : s.status === "finished" ? "finished" : s.roundClosedAt === null ? "question" : "reveal";
  const showQuestion = s.status === "playing";
  const mine = me ? cur[me.id] : undefined;
  return {
    code: s.code,
    status: s.status,
    phase,
    settings: s.settings,
    you: { member: !!me, host: s.hostId === playerId, name: me?.name ?? null, answered: !!mine, input: mine?.input ?? null },
    hostName: member(s, s.hostId)?.name ?? "",
    members,
    round: s.round,
    totalRounds: s.questionIds.length || s.settings.rounds,
    question: showQuestion ? toPublic(bank.get(s.questionIds[s.round]), s.round) : null,
    deadline: showQuestion && s.roundStartedAt !== null ? deadlineOf(s) : null,
    revealUntil: phase === "reveal" ? s.roundClosedAt! + REVEAL_MS : null,
    answeredCount: Object.keys(cur).length,
    reveal: phase === "reveal" ? revealRound(s, bank, s.round, playerId) : null,
    history: s.status === "finished" ? s.questionIds.map((_, i) => revealRound(s, bank, i, playerId)) : [],
  };
}
