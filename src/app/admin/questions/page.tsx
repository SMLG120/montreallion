import Link from "next/link";
import { CATEGORY_LABELS } from "@/lib/i18n/dict";
import type { CategoryId } from "@/lib/game/types";
import { listQuestions, REVIEW_STATUSES, type ReviewStatus } from "@/lib/server/admin-data";
import { requireAdmin } from "@/lib/server/admin-auth";
import { getSql } from "@/lib/server/db";
import { getDict, getLocale } from "@/lib/server/locale";
import { inputCls } from "../ui";

export default async function AdminQuestions({ searchParams }: PageProps<"/admin/questions">) {
  await requireAdmin();
  const [t, locale] = await Promise.all([getDict(), getLocale()]);
  const A = t.admin;
  const sql = getSql();
  if (!sql) return <p>{A.noDb}</p>;
  const sp = await searchParams;
  const status = (REVIEW_STATUSES as string[]).includes(String(sp.status)) ? (sp.status as ReviewStatus) : "in_review";
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const rows = await listQuestions(sql, status, q);
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-extrabold">{A.nav.questions}</h1>
      <div className="flex flex-wrap gap-2">
        {REVIEW_STATUSES.map((s) => (
          <Link
            key={s}
            href={`/admin/questions?status=${s}`}
            className={`rounded-full border border-border px-3 py-1 text-sm font-bold ${s === status ? "bg-muted" : ""}`}
            aria-current={s === status ? "page" : undefined}
          >
            {A.status[s]}
          </Link>
        ))}
      </div>
      <form className="flex gap-2">
        <input type="hidden" name="status" value={status} />
        <input name="q" defaultValue={q} placeholder={A.search} className={inputCls} />
      </form>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">{A.noRows}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border" data-testid="question-list">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/admin/questions/${encodeURIComponent(r.id)}`} className="block px-4 py-3 hover:bg-muted" data-testid="question-row">
                <span className="block text-xs uppercase tracking-wider text-muted-foreground">
                  {CATEGORY_LABELS[r.category_id as CategoryId]?.[locale] ?? r.category_id} · {r.template ?? r.verification} · {A.answers(r.answers)}
                  {r.reviewed_by && ` · ${r.reviewed_by}`}
                </span>
                <span className="block font-bold">{locale === "fr" ? r.prompt_fr : r.prompt_en}</span>
                <span className="block font-mono text-xs text-muted-foreground">{r.id}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
