import type { RideRow } from "./profile";
import type { Sql } from "@/lib/server/db";
import type { Bank } from "./bank";
import type { Precheck, Session, Submission } from "./engine";
import { anonTag, type AccountProfile, type Board, type DailyChallenge, type DayCounts, type FrozenScores, type SessionStore } from "./store";
import type { Tier } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type SessionRow = {
  id: string;
  player_id: string;
  mode: "daily" | "unlimited";
  date_key: string | null;
  rarity_model_id: string;
  question_ids: string[];
  current_index: number;
  served_at: Date | null;
  created_at: Date;
  finished_at: Date | null;
  score_snapshot: FrozenScores | null;
  precheck: Precheck | null;
};

type SubRow = {
  question_id: string;
  input: string;
  status: Submission["status"];
  slug: string | null;
  matched_by: Submission["matchedBy"];
  score: number;
  tier: Tier | null;
  share: number | null;
  elapsed_ms: number;
  rarity_basis: Submission["basis"];
  rarity_sample: number | null;
};

const ms = (d: Date | null) => (d ? d.getTime() : null);

function toSession(r: SessionRow, subs: SubRow[]): Session {
  return {
    id: r.id,
    playerId: r.player_id,
    mode: r.mode,
    dateKey: r.date_key,
    rarityModel: r.rarity_model_id,
    questionIds: r.question_ids,
    index: r.current_index,
    servedAt: ms(r.served_at),
    createdAt: r.created_at.getTime(),
    finishedAt: ms(r.finished_at),
    frozenScores: r.score_snapshot,
    precheck: r.precheck,
    submissions: subs.map((x) => ({
      questionId: x.question_id,
      input: x.input,
      status: x.status,
      answerId: x.slug,
      matchedBy: x.matched_by,
      score: x.score,
      tier: x.tier,
      share: x.share,
      basis: x.rarity_basis,
      sample: x.rarity_sample,
      elapsedMs: x.elapsed_ms,
    })),
  };
}

/**
 * Supabase/Postgres store. Every mutation runs in one transaction holding a
 * row lock (`SELECT … FOR UPDATE`) on the session, so concurrent requests are
 * serialized across serverless instances; `unique (session_id, position)` is
 * the last line of defence against double answers.
 */
export function createPostgresStore(sql: Sql, getBank: () => Promise<Bank>): SessionStore {
  async function load(q: Sql, id: string, lock: boolean): Promise<Session | null> {
    const rows = lock
      ? await q<SessionRow[]>`
          select s.id, s.player_id, s.mode, s.date_key::text as date_key, s.rarity_model_id, s.question_ids, s.current_index,
                 s.served_at, s.created_at, s.finished_at, d.score_snapshot, s.precheck
          from sessions s left join daily_challenges d on d.date_key = s.date_key
          where s.id = ${id} for update of s`
      : await q<SessionRow[]>`
          select s.id, s.player_id, s.mode, s.date_key::text as date_key, s.rarity_model_id, s.question_ids, s.current_index,
                 s.served_at, s.created_at, s.finished_at, d.score_snapshot, s.precheck
          from sessions s left join daily_challenges d on d.date_key = s.date_key
          where s.id = ${id}`;
    if (!rows.length) return null;
    const subs = await q<SubRow[]>`
      select sub.question_id, sub.input, sub.status, a.slug, sub.matched_by, sub.score, sub.tier, sub.share, sub.elapsed_ms, sub.rarity_basis, sub.rarity_sample
      from submissions sub left join answers a on a.id = sub.answer_id
      where sub.session_id = ${id} order by sub.position`;
    return toSession(rows[0], subs);
  }

  return {
    kind: "postgres",

    async get(id) {
      return UUID_RE.test(id) ? load(sql, id, false) : null;
    },

    async ensurePlayer(playerId) {
      await sql`insert into players (id) values (${playerId})
                on conflict (id) do update set last_seen_at = now()`;
    },

    async getOrCreateDaily(dateKey, make) {
      const existing = await sql<{ question_ids: string[]; rarity_model_id: string; bank_version: string; score_snapshot: FrozenScores }[]>`
        select question_ids, rarity_model_id, bank_version, score_snapshot from daily_challenges where date_key = ${dateKey}`;
      if (!existing.length) {
        const d = make();
        await sql`insert into daily_challenges (date_key, question_ids, rarity_model_id, bank_version, score_snapshot)
                  values (${dateKey}, ${d.questionIds}, ${d.rarityModel}, ${d.bankVersion}, ${sql.json(d.scores)})
                  on conflict (date_key) do nothing`;
        return this.getOrCreateDaily(dateKey, () => {
          throw new Error("daily challenge vanished");
        });
      }
      const r = existing[0];
      const out: DailyChallenge = { dateKey, questionIds: r.question_ids, rarityModel: r.rarity_model_id, bankVersion: r.bank_version, scores: r.score_snapshot };
      return out;
    },

    async createSession(s) {
      const inserted = await sql<{ id: string }[]>`
        insert into sessions (id, player_id, mode, date_key, rarity_model_id, question_ids, current_index, created_at)
        values (${s.id}, ${s.playerId}, ${s.mode}, ${s.dateKey}, ${s.rarityModel}, ${s.questionIds}, 0, ${new Date(s.createdAt)})
        on conflict (player_id, date_key) where mode = 'daily' do nothing
        returning id`;
      if (!inserted.length && s.dateKey) {
        const existing = await this.findDaily(s.playerId, s.dateKey);
        if (existing) return existing;
      }
      return (await load(sql, s.id, false))!;
    },

    async findDaily(playerId, dateKey) {
      const r = await sql<{ id: string }[]>`select id from sessions where player_id = ${playerId} and date_key = ${dateKey} and mode = 'daily'`;
      return r.length ? load(sql, r[0].id, false) : null;
    },

    async mutate(id, fn) {
      if (!UUID_RE.test(id)) return null;
      const bank = await getBank();
      return sql.begin(async (tx) => {
        const s = await load(tx as unknown as Sql, id, true);
        if (!s) return null;
        const before = s.submissions.length;
        const result = fn(s); // a throw rolls the transaction back
        const total = s.submissions.reduce((t, x) => t + x.score, 0);
        const elapsed = s.submissions.reduce((t, x) => t + Math.round(x.elapsedMs), 0);
        await tx`update sessions set current_index = ${s.index}, served_at = ${s.servedAt === null ? null : new Date(s.servedAt)},
                   total_score = ${total}, total_elapsed_ms = ${elapsed}, finished_at = ${s.finishedAt === null ? null : new Date(s.finishedAt)},
                   precheck = ${s.precheck ? tx.json(s.precheck as never) : null}
                 where id = ${id}`;
        for (const [i, sub] of s.submissions.slice(before).entries()) {
          const answerDbId = sub.answerId ? bank.answerDbId(sub.questionId, sub.answerId) : null;
          if (sub.answerId && answerDbId === null) throw new Error(`No DB id for ${sub.questionId}:${sub.answerId}`);
          await tx`insert into submissions (session_id, position, question_id, input, status, answer_id, matched_by, score, tier, share, elapsed_ms, rarity_basis, rarity_sample)
                   values (${id}, ${before + i}, ${sub.questionId}, ${sub.input}, ${sub.status}, ${answerDbId}, ${sub.matchedBy},
                           ${sub.score}, ${sub.tier}, ${sub.share}, ${Math.round(sub.elapsedMs)}, ${sub.basis}, ${sub.sample})`;
          // Frequencies for the future statistical rarity model (only server-validated answers).
          await tx`insert into question_stats (question_id, attempts, correct) values (${sub.questionId}, 1, ${sub.status === "correct" ? 1 : 0})
                   on conflict (question_id) do update set attempts = question_stats.attempts + 1,
                     correct = question_stats.correct + excluded.correct, updated_at = now()`;
          if (answerDbId !== null) {
            // Rarity counts DISTINCT players per answer, so replaying Unlimited can't inflate an answer.
            const first = await tx`insert into answer_players (answer_id, player_id) values (${answerDbId}, ${s.playerId})
                                   on conflict do nothing returning 1`;
            const add = first.length;
            await tx`insert into answer_stats (answer_id, question_id, correct_count, players) values (${answerDbId}, ${sub.questionId}, 1, ${add})
                     on conflict (answer_id) do update set correct_count = answer_stats.correct_count + 1,
                       players = answer_stats.players + excluded.players, updated_at = now()`;
          }
        }
        return { session: s, result };
      }) as Promise<{ session: Session; result: ReturnType<typeof fn> } | null>;
    },

    async leaderboard(dateKey, playerId, limit): Promise<Board> {
      const rows = await sql<{ player_id: string; display_name: string | null; total_score: number; total_elapsed_ms: number; rank: string; players: string }[]>`
        with board as (
          select s.player_id, p.display_name, s.total_score, s.total_elapsed_ms, s.finished_at,
                 rank() over (order by s.total_score desc, s.total_elapsed_ms asc) as rank,
                 count(*) over () as players
          from sessions s join players p on p.id = s.player_id
          where s.mode = 'daily' and s.date_key = ${dateKey} and s.finished_at is not null
        )
        select player_id, display_name, total_score, total_elapsed_ms, rank, players from board
        where rank <= ${limit} or player_id = ${playerId ?? "00000000-0000-0000-0000-000000000000"}
        order by rank, finished_at limit ${limit + 1}`;
      const entries = rows.map((r) => ({
        rank: Number(r.rank),
        name: r.display_name,
        tag: anonTag(r.player_id),
        score: r.total_score,
        elapsedMs: r.total_elapsed_ms,
        you: r.player_id === playerId,
      }));
      return {
        dateKey,
        players: rows.length ? Number(rows[0].players) : 0,
        top: entries.filter((e) => e.rank <= limit).slice(0, limit),
        you: entries.find((e) => e.you) ?? null,
      };
    },

    async dailyCounts(dateKey) {
      const rows = await sql<{ question_id: string; slug: string | null; c: string }[]>`
        select sub.question_id, a.slug, count(*) as c
        from submissions sub join sessions s on s.id = sub.session_id left join answers a on a.id = sub.answer_id
        where s.mode = 'daily' and s.date_key = ${dateKey}
        group by 1, 2`;
      const out: Record<string, DayCounts> = {};
      for (const r of rows) {
        const c = (out[r.question_id] ??= { players: 0, bySlug: {} });
        c.players += Number(r.c);
        if (r.slug) c.bySlug[r.slug] = Number(r.c);
      }
      return out;
    },

    async recentQuestionIds(playerId, n) {
      const rows = await sql<{ question_ids: string[] }[]>`
        select question_ids from sessions where player_id = ${playerId} order by created_at desc limit ${n}`;
      return rows.flatMap((r) => r.question_ids);
    },

    async getDisplayName(playerId) {
      const r = await sql<{ display_name: string | null }[]>`select display_name from players where id = ${playerId}`;
      return r[0]?.display_name ?? null;
    },

    async setDisplayName(playerId, name) {
      await sql`insert into players (id, display_name, name_updated_at) values (${playerId}, ${name}, ${name ? new Date() : null})
                on conflict (id) do update set display_name = excluded.display_name, last_seen_at = now(),
                  name_updated_at = case when excluded.display_name is null then null else now() end`;
    },

    async linkAccount(userId, playerId) {
      await sql`insert into players (id) values (${playerId}) on conflict (id) do nothing`;
      const r = await sql<{ user_id: string }[]>`
        insert into account_players (player_id, user_id) values (${playerId}, ${userId})
        on conflict (player_id) do update set player_id = excluded.player_id
        returning user_id`;
      return r[0]?.user_id === userId;
    },

    async accountPlayers(userId) {
      const r = await sql<{ player_id: string }[]>`
        select player_id from account_players where user_id = ${userId} order by linked_at, player_id`;
      return r.map((x) => x.player_id);
    },

    async finishedRides(playerIds, limit) {
      if (!playerIds.length) return [];
      const r = await sql<{ id: string; mode: "daily" | "unlimited"; date_key: string | null; finished_at: Date; total_score: number; tiers: (string | null)[] | null }[]>`
        select s.id, s.mode, to_char(s.date_key, 'YYYY-MM-DD') as date_key, s.finished_at, s.total_score,
               (select array_agg(sub.tier::text order by sub.position) from submissions sub where sub.session_id = s.id) as tiers
        from sessions s
        where s.player_id = any(${playerIds}::uuid[]) and s.finished_at is not null
        order by s.finished_at desc limit ${limit}`;
      return r.map((x) => ({
        id: x.id, mode: x.mode, dateKey: x.date_key, finishedAt: x.finished_at.getTime(), total: x.total_score,
        tiers: (x.tiers ?? []) as RideRow["tiers"],
      }));
    },

    async getProfile(userId) {
      const rows = await asAccount(userId, (tx) => tx<ProfileRow[]>`select display_name, appearance from account_profiles where user_id = ${userId}`);
      return rows[0] ? profileOf(rows[0]) : null;
    },

    async saveProfile(userId, patch) {
      const setName = patch.displayName !== undefined;
      const setLook = patch.appearance !== undefined;
      const look = sql.json((patch.appearance ?? {}) as never);
      const rows = await asAccount(userId, (tx) => tx<ProfileRow[]>`
        insert into account_profiles (user_id, display_name, appearance)
        values (${userId}, ${setName ? patch.displayName! : null}, ${look})
        on conflict (user_id) do update set
          display_name = case when ${setName} then excluded.display_name else account_profiles.display_name end,
          appearance = case when ${setLook} then excluded.appearance else account_profiles.appearance end,
          updated_at = now()
        returning display_name, appearance`);
      return profileOf(rows[0]);
    },
  };

  /**
   * Runs `fn` as the restricted `montreallion_account` role with `montreallion.user_id` set to the verified user,
   * so Postgres row-level security (not just this code) limits it to that user's own profile row.
   */
  function asAccount<T>(userId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
    return sql.begin(async (tx) => {
      await tx`select set_config('montreallion.user_id', ${userId}, true)`;
      await tx`set local role montreallion_account`;
      return fn(tx as unknown as Sql);
    }) as Promise<T>;
  }
}

type ProfileRow = { display_name: string | null; appearance: Record<string, unknown> | null };
const profileOf = (r: ProfileRow): AccountProfile => ({ displayName: r.display_name, appearance: r.appearance ?? {} });
