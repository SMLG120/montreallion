import Link from "next/link";
import { dateKey } from "@/lib/game/daily";
import { overview, REVIEW_STATUSES } from "@/lib/server/admin-data";
import { adminEnabled, requireAdmin } from "@/lib/server/admin-auth";
import { getSql } from "@/lib/server/db";
import { getDict } from "@/lib/server/locale";

export default async function AdminHome() {
  const t = await getDict();
  const A = t.admin;
  if (!adminEnabled()) return <Notice title={A.title} body={A.disabled} />;
  await requireAdmin();
  const sql = getSql();
  if (!sql) return <Notice title={A.title} body={A.noDb} />;
  const o = await overview(sql, dateKey());
  return (
    <div className="space-y-6">
      <h1 className="text-4xl font-extrabold">{A.title}</h1>
      <section className="space-y-2">
        <h2 className="font-bold">{A.overview.questions}</h2>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {REVIEW_STATUSES.map((s) => (
            <li key={s}>
              <Link href={`/admin/questions?status=${s}`} className="tile block p-3 hover:opacity-90" data-testid={`count-${s}`}>
                <span className="block font-heading text-3xl font-extrabold tabular-nums">{o.questions[s] ?? 0}</span>
                <span className="text-sm text-muted-foreground">{A.status[s]}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <ul className="space-y-1 text-sm">
        <li>
          <Link href="/admin/appeals" className="underline">
            {A.overview.openAppeals}: <strong>{o.openAppeals}</strong>
          </Link>
        </li>
        <li>
          <Link href="/admin/names" className="underline">
            {A.overview.namedPlayers}: <strong>{o.namedPlayers}</strong>
          </Link>
        </li>
        <li>{A.overview.daily(o.daily.started, o.daily.finished)}</li>
      </ul>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="space-y-4 py-10">
      <h1 className="text-4xl font-extrabold">{title}</h1>
      <p className="text-muted-foreground">{body}</p>
    </div>
  );
}
