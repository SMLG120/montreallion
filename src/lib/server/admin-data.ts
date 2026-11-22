import "server-only";
import { invalidateBank } from "@/lib/game/bank";
import { editDistance, normalizeAnswer } from "@/lib/game/normalize";
import { anonTag } from "@/lib/game/store";
import type { Sql } from "./db";

export type ReviewStatus = "draft" | "in_review" | "approved" | "rejected";
export const REVIEW_STATUSES: ReviewStatus[] = ["in_review", "approved", "rejected", "draft"];

/* ------------------------------------------------------------------ overview */
export async function overview(sql: Sql, today: string) {
  const [qs, ap, names, daily] = await Promise.all([
    sql<{ review_status: ReviewStatus; c: number }[]>`select review_status, count(*)::int as c from questions group by 1`,
    sql<{ c: number }[]>`select count(*)::int as c from appeals where status = 'open'`,
    sql<{ c: number }[]>`select count(*)::int as c from players where display_name is not null`,
    sql<{ started: number; finished: number }[]>`
      select count(*)::int as started, count(finished_at)::int as finished from sessions where mode = 'daily' and date_key = ${today}`,
  ]);
  return {
    questions: Object.fromEntries(qs.map((r) => [r.review_status, r.c])) as Partial<Record<ReviewStatus, number>>,
    openAppeals: ap[0].c,
    namedPlayers: names[0].c,
    daily: daily[0],
  };
}

/* ------------------------------------------------------------------ questions */
export async function listQuestions(sql: Sql, status: ReviewStatus, search: string) {
  const like = `%${search.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  return sql<
    { id: string; category_id: string; prompt_en: string; prompt_fr: string; verification: string; template: string | null; answers: number; reviewed_by: string | null }[]
  >`
    select q.id, q.category_id, q.prompt_en, q.prompt_fr, q.verification, q.generator->>'template' as template,
           (select count(*)::int from answers a where a.question_id = q.id) as answers,
           (select reviewer from question_reviews r where r.question_id = q.id order by created_at desc, id desc limit 1) as reviewed_by
    from questions q
    where q.review_status = ${status}
      and (${search} = '' or q.id ilike ${like} or q.prompt_en ilike ${like} or q.prompt_fr ilike ${like})
    order by q.category_id, q.id
    limit 300`;
}

export async function getQuestion(sql: Sql, id: string) {
  const [q] = await sql<
    {
      id: string; category_id: string; scope: string; prompt_en: string; prompt_fr: string; eligibility_en: string; eligibility_fr: string;
      verification: string; review_status: ReviewStatus; ambiguous_keys: string[]; est_basis: string; generator: { template: string; concept: string } | null;
      content_hash: string; bank_version: string;
    }[]
  >`select id, category_id, scope, prompt_en, prompt_fr, eligibility_en, eligibility_fr, verification, review_status, ambiguous_keys,
           est_basis, generator, content_hash, bank_version from questions where id = ${id}`;
  if (!q) return null;
  const [answers, aliases, sources, reviews] = await Promise.all([
    sql<{ id: number; slug: string; label_en: string; label_fr: string | null; est_weight: number; refs: string[]; players: number | null }[]>`
      select a.id, a.slug, a.label_en, a.label_fr, a.est_weight, a.refs, st.players
      from answers a left join answer_stats st on st.answer_id = a.id where a.question_id = ${id} order by a.est_weight desc, a.slug`,
    sql<{ answer_id: number; alias: string; source: string }[]>`
      select answer_id, alias, source from answer_aliases where question_id = ${id} and not is_label order by id`,
    sql<{ title: string; url: string; license: string; retrieved: string }[]>`
      select s.title, s.url, s.license, s.retrieved::text as retrieved from question_sources qs join sources s on s.id = qs.source_id where qs.question_id = ${id}`,
    sql<{ status: ReviewStatus; reviewer: string; note: string | null; created_at: Date; current: boolean }[]>`
      select status, reviewer, note, created_at, content_hash = ${q.content_hash} as current
      from question_reviews where question_id = ${id} order by created_at desc, id desc limit 20`,
  ]);
  const byAnswer = new Map<number, { alias: string; source: string }[]>();
  for (const a of aliases) byAnswer.set(a.answer_id, [...(byAnswer.get(a.answer_id) ?? []), { alias: a.alias, source: a.source }]);
  return { ...q, answers: answers.map((a) => ({ ...a, aliases: byAnswer.get(a.id) ?? [] })), sources, reviews };
}

export type ReviewResult = "ok" | "not_found" | "stale";

/** Records a review and applies it, unless the question changed since the reviewer loaded it. */
export async function reviewQuestion(sql: Sql, id: string, status: "approved" | "rejected" | "in_review", reviewer: string, note: string, seenHash: string): Promise<ReviewResult> {
  const out = await sql.begin(async (tx) => {
    const [q] = await tx<{ content_hash: string }[]>`select content_hash from questions where id = ${id} for update`;
    if (!q) return "not_found" as const;
    if (q.content_hash !== seenHash) return "stale" as const;
    await tx`insert into question_reviews (question_id, status, reviewer, note, content_hash)
             values (${id}, ${status}, ${reviewer}, ${note || null}, ${seenHash})`;
    await tx`update questions set review_status = ${status}, updated_at = now() where id = ${id}`;
    return "ok" as const;
  });
  if (out === "ok") invalidateBank();
  return out;
}

/* ------------------------------------------------------------------ appeals */
export async function listAppeals(sql: Sql, status: "open" | "accepted" | "rejected") {
  const rows = await sql<
    {
      id: number; question_id: string; prompt_en: string; prompt_fr: string; input: string; note: string | null; created_at: Date;
      resolution: string | null; resolved_by: string | null; admin_note: string | null; mode: string;
    }[]
  >`
    select ap.id, sub.question_id, q.prompt_en, q.prompt_fr, sub.input, ap.note, ap.created_at,
           ap.resolution, ap.resolved_by, ap.admin_note, s.mode::text as mode
    from appeals ap
    join submissions sub on sub.id = ap.submission_id
    join sessions s on s.id = sub.session_id
    join questions q on q.id = sub.question_id
    where ap.status = ${status}
    order by ap.created_at ${status === "open" ? sql`asc` : sql`desc`}
    limit 200`;
  const qids = [...new Set(rows.map((r) => r.question_id))];
  const answers = qids.length
    ? await sql<{ question_id: string; slug: string; label_en: string; label_fr: string | null; keys: string[] }[]>`
        select a.question_id, a.slug, a.label_en, a.label_fr, array_agg(al.normalized_key) as keys
        from answers a left join answer_aliases al on al.answer_id = a.id
        where a.question_id = any(${qids}) group by a.id`
    : [];
  return rows.map((r) => {
    const key = normalizeAnswer(r.input);
    const nearest = answers
      .filter((a) => a.question_id === r.question_id)
      .map((a) => ({
        slug: a.slug,
        label: a.label_fr && a.label_fr !== a.label_en ? `${a.label_en} / ${a.label_fr}` : a.label_en,
        distance: Math.min(...(a.keys.filter(Boolean) as string[]).map((k) => editDistance(key, k, 50)), 99),
      }))
      .sort((a, b) => a.distance - b.distance || a.slug.localeCompare(b.slug))
      .slice(0, 5);
    return { ...r, key, nearest, allAnswers: answers.filter((a) => a.question_id === r.question_id).map((a) => ({ slug: a.slug, label: a.label_en })) };
  });
}

export type ResolveResult = "ok" | "not_found" | "not_open" | "empty_key" | "key_taken" | "ambiguous_key" | "bad_answer";

/**
 * Resolves an appeal. "alias" adds the player's (normalized) input as an alias of one answer; it refuses
 * keys already used by any answer of the question or listed as ambiguous, so it can never make matching ambiguous.
 * Scores already given are not changed (frozen dailies stay fair for everyone).
 */
export async function resolveAppeal(
  sql: Sql,
  appealId: number,
  action: "alias" | "noted" | "rejected",
  reviewer: string,
  note: string,
  answerSlug?: string,
): Promise<ResolveResult> {
  const out = await sql.begin(async (tx) => {
    const [ap] = await tx<{ status: string; question_id: string; input: string; ambiguous_keys: string[] }[]>`
      select ap.status, sub.question_id, sub.input, q.ambiguous_keys
      from appeals ap join submissions sub on sub.id = ap.submission_id join questions q on q.id = sub.question_id
      where ap.id = ${appealId} for update of ap`;
    if (!ap) return "not_found" as const;
    if (ap.status !== "open") return "not_open" as const;
    let aliasAnswerId: number | null = null;
    if (action === "alias") {
      const key = normalizeAnswer(ap.input);
      if (!key) return "empty_key" as const;
      if (ap.ambiguous_keys.includes(key)) return "ambiguous_key" as const;
      const [ans] = await tx<{ id: number }[]>`select id from answers where question_id = ${ap.question_id} and slug = ${answerSlug ?? ""}`;
      if (!ans) return "bad_answer" as const;
      const taken = await tx`select 1 from answer_aliases where question_id = ${ap.question_id} and normalized_key = ${key}`;
      if (taken.length) return "key_taken" as const;
      await tx`insert into answer_aliases (answer_id, question_id, alias, normalized_key, is_label, source)
               values (${ans.id}, ${ap.question_id}, ${ap.input.trim().slice(0, 120)}, ${key}, false, 'appeal')`;
      aliasAnswerId = ans.id;
    }
    await tx`update appeals set status = ${action === "rejected" ? "rejected" : "accepted"}, resolution = ${action},
               resolved_by = ${reviewer}, admin_note = ${note || null}, alias_answer_id = ${aliasAnswerId}, resolved_at = now()
             where id = ${appealId}`;
    return "ok" as const;
  });
  if (out === "ok" && action === "alias") invalidateBank();
  return out;
}

/* ------------------------------------------------------------------ names */
export async function listNames(sql: Sql) {
  const rows = await sql<{ id: string; display_name: string; name_updated_at: Date | null; dailies: number }[]>`
    select p.id, p.display_name, p.name_updated_at,
           (select count(*)::int from sessions s where s.player_id = p.id and s.mode = 'daily' and s.finished_at is not null) as dailies
    from players p where p.display_name is not null
    order by p.name_updated_at desc nulls last limit 300`;
  return rows.map((r) => ({ ...r, tag: anonTag(r.id) }));
}

export async function resetName(sql: Sql, playerId: string) {
  await sql`update players set display_name = null, name_updated_at = null where id = ${playerId}`;
}
