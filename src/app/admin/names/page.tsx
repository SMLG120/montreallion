import { listNames } from "@/lib/server/admin-data";
import { requireAdmin } from "@/lib/server/admin-auth";
import { getSql } from "@/lib/server/db";
import { getDict, getLocale } from "@/lib/server/locale";
import { clearName } from "../actions";
import { btnCls, Msg } from "../ui";

export default async function AdminNames({ searchParams }: PageProps<"/admin/names">) {
  await requireAdmin();
  const [t, locale] = await Promise.all([getDict(), getLocale()]);
  const A = t.admin;
  const sql = getSql();
  if (!sql) return <p>{A.noDb}</p>;
  const m = (await searchParams).msg;
  const rows = await listNames(sql);
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-extrabold">{A.nav.names}</h1>
      <Msg ok text={m === "ok" ? A.msg.ok : undefined} />
      <p className="text-sm text-muted-foreground">{A.names.help}</p>
      {rows.length === 0 && <p className="text-muted-foreground">{A.noRows}</p>}
      <ul className="divide-y divide-border rounded-xl border border-border">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-3 px-4 py-2" data-testid="name-row">
            <span className="min-w-0 flex-1">
              <strong>{r.display_name}</strong> <span className="text-xs text-muted-foreground">#{r.tag}</span>
              <span className="block text-xs text-muted-foreground">
                {r.name_updated_at?.toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { timeZone: "America/Toronto" })} · {A.names.dailies}: {r.dailies}
              </span>
            </span>
            <form action={clearName}>
              <input type="hidden" name="player" value={r.id} />
              <button className={`${btnCls} border border-border`} data-testid="name-reset">
                {A.names.reset}
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
