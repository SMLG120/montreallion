import Link from "next/link";
import { notFound } from "next/navigation";
import { getQuestion } from "@/lib/server/admin-data";
import { requireAdmin } from "@/lib/server/admin-auth";
import { getSql } from "@/lib/server/db";
import { getDict, getLocale } from "@/lib/server/locale";
import { review } from "../../actions";
import { btnCls, inputCls, Msg } from "../../ui";

export default async function AdminQuestion({ params, searchParams }: PageProps<"/admin/questions/[id]">) {
  await requireAdmin();
  const [t, locale] = await Promise.all([getDict(), getLocale()]);
  const A = t.admin;
  const sql = getSql();
  if (!sql) return <p>{A.noDb}</p>;
  const id = decodeURIComponent((await params).id);
  const q = await getQuestion(sql, id);
  if (!q) notFound();
  const { msg } = await searchParams;
  const m = typeof msg === "string" ? msg : undefined;

  return (
    <article className="space-y-6">
      <Link href={`/admin/questions?status=${q.review_status}`} className="text-sm underline">
        ← {A.back}
      </Link>
      <Msg ok={m === "ok"} text={m ? A.msg[m] : undefined} />
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          <span data-testid="admin-status">{A.status[q.review_status]}</span> · {q.category_id} · {q.scope} · {q.verification}
          {q.generator && ` · ${q.generator.template} (${q.generator.concept})`}
        </p>
        <h1 className="text-2xl font-extrabold">{q.prompt_en}</h1>
        <p className="text-xl font-bold opacity-80" lang="fr">
          {q.prompt_fr}
        </p>
        <p className="font-mono text-xs text-muted-foreground">{q.id}</p>
      </header>

      <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="font-bold">{A.eligibility}</dt>
        <dd>
          {q.eligibility_en}
          <br />
          <span lang="fr" className="opacity-80">
            {q.eligibility_fr}
          </span>
        </dd>
        <dt className="font-bold">{A.sources}</dt>
        <dd>
          <ul className="space-y-1">
            {q.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} className="underline" rel="noreferrer noopener" target="_blank">
                  {s.title}
                </a>{" "}
                <span className="text-muted-foreground">
                  · {s.license} · {s.retrieved}
                </span>
              </li>
            ))}
          </ul>
        </dd>
        <dt className="font-bold">{A.estBasis}</dt>
        <dd>{q.est_basis}</dd>
        <dt className="font-bold">{A.ambiguous}</dt>
        <dd className="font-mono">{q.ambiguous_keys.join(", ") || "—"}</dd>
        <dt className="font-bold">{A.hash}</dt>
        <dd className="font-mono">{q.content_hash}</dd>
      </dl>

      <form action={review} className="space-y-3 rounded-xl border border-border p-4">
        <input type="hidden" name="id" value={q.id} />
        <input type="hidden" name="hash" value={q.content_hash} />
        <input name="note" maxLength={500} placeholder={A.note} className={inputCls} data-testid="review-note" />
        <div className="flex flex-wrap gap-2">
          <button name="status" value="approved" className={`${btnCls} bg-[var(--line-green)] text-black`} data-testid="review-approve">
            {A.approve}
          </button>
          <button name="status" value="rejected" className={`${btnCls} bg-destructive text-white`} data-testid="review-reject">
            {A.reject}
          </button>
          <button name="status" value="in_review" className={`${btnCls} border border-border`}>
            {A.toReview}
          </button>
        </div>
      </form>

      <section className="space-y-2">
        <h2 className="font-bold">
          {A.answers(q.answers.length)}
        </h2>
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted text-xs uppercase">
              <tr>
                <th className="px-3 py-2">EN / FR</th>
                <th className="px-3 py-2">est</th>
                <th className="px-3 py-2">{A.players}</th>
                <th className="px-3 py-2">{A.aliases}</th>
              </tr>
            </thead>
            <tbody>
              {q.answers.map((a) => (
                <tr key={a.id} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <span className="font-bold">{a.label_en}</span>
                    {a.label_fr && a.label_fr !== a.label_en && <span className="block opacity-80">{a.label_fr}</span>}
                    <span className="block font-mono text-xs text-muted-foreground">{a.refs.join(" ") || a.slug}</span>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{a.est_weight}</td>
                  <td className="px-3 py-2 tabular-nums">{a.players ?? 0}</td>
                  <td className="px-3 py-2 text-xs">
                    {a.aliases.map((x, i) => (
                      <span key={i} className="mr-1 inline-block rounded bg-muted px-1.5 py-0.5">
                        {x.alias}
                        {x.source === "appeal" && <em className="ml-1 text-muted-foreground">({A.fromAppeal})</em>}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {q.reviews.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-bold">{A.history}</h2>
          <ul className="space-y-1 text-sm">
            {q.reviews.map((r, i) => (
              <li key={i}>
                <strong>{A.status[r.status]}</strong> · {r.reviewer} · {r.created_at.toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { timeZone: "America/Toronto" })}
                {r.note && ` — ${r.note}`}
                {!r.current && <em className="text-muted-foreground"> ({A.outdated})</em>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
