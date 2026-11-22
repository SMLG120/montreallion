import Link from "next/link";
import { listAppeals } from "@/lib/server/admin-data";
import { requireAdmin } from "@/lib/server/admin-auth";
import { getSql } from "@/lib/server/db";
import { getDict, getLocale } from "@/lib/server/locale";
import { resolve } from "../actions";
import { btnCls, inputCls, Msg } from "../ui";

const STATUSES = ["open", "accepted", "rejected"] as const;

export default async function AdminAppeals({ searchParams }: PageProps<"/admin/appeals">) {
  await requireAdmin();
  const [t, locale] = await Promise.all([getDict(), getLocale()]);
  const A = t.admin;
  const sql = getSql();
  if (!sql) return <p>{A.noDb}</p>;
  const sp = await searchParams;
  const status = (STATUSES as readonly string[]).includes(String(sp.status)) ? (sp.status as (typeof STATUSES)[number]) : "open";
  const m = typeof sp.msg === "string" ? sp.msg : undefined;
  const rows = await listAppeals(sql, status);
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-extrabold">{A.nav.appeals}</h1>
      <Msg ok={m === "ok"} text={m ? A.msg[m] : undefined} />
      <p className="text-sm text-muted-foreground">{A.appeal.help}</p>
      <div className="flex gap-2">
        {STATUSES.map((s) => (
          <Link key={s} href={`/admin/appeals?status=${s}`} className={`rounded-full border border-border px-3 py-1 text-sm font-bold ${s === status ? "bg-muted" : ""}`}>
            {A.appeal[s]}
          </Link>
        ))}
      </div>
      {rows.length === 0 && <p className="text-muted-foreground">{A.noRows}</p>}
      <ul className="space-y-4">
        {rows.map((r) => (
          <li key={r.id} id={`appeal-${r.id}`} className="space-y-3 rounded-xl border border-border p-4" data-testid="appeal-row">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              #{r.id} · {r.mode} · {r.created_at.toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { timeZone: "America/Toronto" })} ·{" "}
              <Link className="underline" href={`/admin/questions/${encodeURIComponent(r.question_id)}`}>
                {r.question_id}
              </Link>
            </p>
            <p className="font-bold">{locale === "fr" ? r.prompt_fr : r.prompt_en}</p>
            <dl className="grid gap-1 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted-foreground">{A.appeal.input}</dt>
              <dd className="font-bold" data-testid="appeal-input">
                “{r.input}”
              </dd>
              <dt className="text-muted-foreground">{A.appeal.key}</dt>
              <dd className="font-mono">{r.key || "—"}</dd>
              {r.note && (
                <>
                  <dt className="text-muted-foreground">{A.appeal.playerNote}</dt>
                  <dd>{r.note}</dd>
                </>
              )}
              <dt className="text-muted-foreground">{A.appeal.nearest}</dt>
              <dd>{r.nearest.map((n) => `${n.label} (${n.distance})`).join(" · ")}</dd>
            </dl>
            {status === "open" ? (
              <form action={resolve} className="space-y-2">
                <input type="hidden" name="id" value={r.id} />
                <div className="flex flex-wrap gap-2">
                  <select name="answer" defaultValue={r.nearest[0]?.slug ?? ""} className={`${inputCls} sm:w-auto`} aria-label={A.appeal.countAs} data-testid="appeal-answer">
                    <option value="">{A.appeal.countAs}</option>
                    {r.allAnswers.map((a) => (
                      <option key={a.slug} value={a.slug}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                  <input name="note" maxLength={500} placeholder={A.note} className={`${inputCls} sm:flex-1`} />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button name="action" value="alias" className={`${btnCls} bg-[var(--line-green)] text-black`} data-testid="appeal-alias">
                    {A.appeal.alias}
                  </button>
                  <button name="action" value="noted" className={`${btnCls} border border-border`}>
                    {A.appeal.noted}
                  </button>
                  <button name="action" value="rejected" className={`${btnCls} bg-destructive text-white`} data-testid="appeal-reject">
                    {A.appeal.reject}
                  </button>
                </div>
              </form>
            ) : (
              <p className="text-sm">
                {A.appeal.resolved(r.resolved_by ?? "?", r.resolution ?? status)}
                {r.admin_note && ` — ${r.admin_note}`}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
