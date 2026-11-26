import "server-only";
import generated from "../../../data/generated/questions.generated.json";
import seed from "../../../data/seed/questions.json";
import { bankFileSchema } from "./schema";
import { OBSERVED_MODEL, type AnswerCounts } from "./scoring";
import { getSql } from "@/lib/server/db";
import type { PublicQuestion, QuestionDef } from "./types";

export type Bank = {
  version: string;
  rarityModel: string;
  /** Approved (playable) questions only. */
  questions: QuestionDef[];
  get(id: string): QuestionDef;
  /** DB primary key of an answer, when the bank was loaded from Postgres. */
  answerDbId(questionId: string, slug: string): number | null;
  /** Distinct-player answer counts from play (Postgres only). */
  counts(questionId: string): AnswerCounts | null;
};

export function buildBank(
  version: string,
  rarityModel: string,
  all: QuestionDef[],
  dbIds?: Map<string, number>,
  counts?: Map<string, AnswerCounts>,
): Bank {
  const questions = all.filter((q) => q.reviewStatus === "approved");
  const byId = new Map(questions.map((q) => [q.id, q]));
  return {
    version,
    rarityModel,
    questions,
    get(id) {
      const q = byId.get(id);
      if (!q) throw new Error(`Unknown question ${id}`);
      return q;
    },
    answerDbId: (qid, slug) => dbIds?.get(`${qid}:${slug}`) ?? null,
    counts: (qid) => counts?.get(qid) ?? null,
  };
}

let seedBankCache: Bank | null = null;
/** Bundled question files (hand-entered seed + ETL output), used when no database is configured. */
export function seedBank(): Bank {
  if (!seedBankCache) {
    const s = bankFileSchema.parse(seed);
    const g = bankFileSchema.parse(generated);
    seedBankCache = buildBank(`${s.version}+${g.version}`, s.rarityModel, [...s.questions, ...g.questions]);
  }
  return seedBankCache;
}

const CACHE_MS = 5 * 60 * 1000;
const g = globalThis as unknown as { __mlBank?: { bank: Bank; at: number } };

/** Loads approved questions from Postgres (cached per instance), or the seed file when no DB is configured. */
export async function getBank(): Promise<Bank> {
  const sql = getSql();
  if (!sql) return seedBank();
  if (g.__mlBank && Date.now() - g.__mlBank.at < CACHE_MS) return g.__mlBank.bank;

  const [qs, ans, aliases, srcs, stats] = await Promise.all([
    sql`select id, category_id, scope, prompt_en, prompt_fr, eligibility_en, eligibility_fr, verification, review_status, ambiguous_keys, bank_version, est_basis,
               -- Read via to_jsonb so a deploy before db:migrate (columns not there yet) still works: they're just null.
               to_jsonb(questions) ->> 'difficulty' as difficulty, to_jsonb(questions) ->> 'answer_type' as answer_type
        from questions where review_status = 'approved' order by id`,
    sql`select a.id, a.question_id, a.slug, a.label_en, a.label_fr, a.est_weight, a.refs
        from answers a join questions q on q.id = a.question_id where q.review_status = 'approved' order by a.id`,
    sql`select al.answer_id, al.alias from answer_aliases al join questions q on q.id = al.question_id
        where q.review_status = 'approved' and not al.is_label order by al.id`,
    sql`select qs.question_id, s.title, s.url, s.license, s.retrieved::text as retrieved
        from question_sources qs join sources s on s.id = qs.source_id`,
    sql`select st.question_id, a.slug, st.players from answer_stats st join answers a on a.id = st.answer_id where st.players > 0`,
  ]);
  const counts = new Map<string, AnswerCounts>();
  for (const r of stats) {
    const c = counts.get(r.question_id) ?? { n: 0, bySlug: {} };
    c.bySlug[r.slug] = r.players;
    c.n += r.players;
    counts.set(r.question_id, c);
  }

  const aliasMap = new Map<number, string[]>();
  for (const r of aliases) aliasMap.set(Number(r.answer_id), [...(aliasMap.get(Number(r.answer_id)) ?? []), r.alias]);
  const dbIds = new Map<string, number>();
  const answersByQ = new Map<string, QuestionDef["answers"]>();
  for (const a of ans) {
    dbIds.set(`${a.question_id}:${a.slug}`, Number(a.id));
    const list = answersByQ.get(a.question_id) ?? [];
    list.push({ id: a.slug, en: a.label_en, ...(a.label_fr ? { fr: a.label_fr } : {}), aliases: aliasMap.get(Number(a.id)) ?? [], est: a.est_weight, refs: a.refs });
    answersByQ.set(a.question_id, list);
  }
  const srcByQ = new Map<string, QuestionDef["sources"]>();
  for (const s of srcs) srcByQ.set(s.question_id, [...(srcByQ.get(s.question_id) ?? []), { title: s.title, url: s.url, license: s.license, retrieved: s.retrieved }]);

  const questions: QuestionDef[] = qs.map((q) => ({
    id: q.id,
    category: q.category_id,
    scope: q.scope,
    prompt: { en: q.prompt_en, fr: q.prompt_fr },
    eligibility: { en: q.eligibility_en, fr: q.eligibility_fr },
    verification: q.verification,
    reviewStatus: q.review_status,
    sources: srcByQ.get(q.id) ?? [],
    ambiguous: q.ambiguous_keys,
    answers: answersByQ.get(q.id) ?? [],
    estBasis: q.est_basis,
    ...(q.difficulty ? { difficulty: q.difficulty } : {}),
    ...(q.answer_type ? { answerType: q.answer_type } : {}),
  }));
  if (questions.length === 0) throw new Error("Question bank is empty — run `npm run db:seed`.");

  const version = [...new Set(qs.map((q) => q.bank_version as string))].sort().join("+");
  const bank = buildBank(`db:${version}`, OBSERVED_MODEL, questions, dbIds, counts);
  g.__mlBank = { bank, at: Date.now() };
  return bank;
}

export function toPublic(q: QuestionDef, index: number): PublicQuestion {
  return {
    id: q.id,
    index,
    category: q.category,
    scope: q.scope,
    prompt: q.prompt,
    eligibility: q.eligibility,
    answerCount: q.answers.length,
    verification: q.verification,
  };
}

/** Drop this instance's cached bank (after admin edits). Other instances refresh within CACHE_MS. */
export function invalidateBank() {
  delete g.__mlBank;
}
