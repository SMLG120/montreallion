import type { Metadata } from "next";
import Link from "next/link";
import { getAdmin } from "@/lib/server/admin-auth";
import { getDict } from "@/lib/server/locale";
import { logout } from "./actions";

export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const [admin, t] = await Promise.all([getAdmin(), getDict()]);
  const A = t.admin;
  return (
    <div className="space-y-6">
      {admin && (
        <nav className="flex flex-wrap items-center gap-2 border-b border-border pb-3 text-sm" aria-label="Admin">
          {(
            [
              ["/admin", A.nav.overview],
              ["/admin/questions", A.nav.questions],
              ["/admin/appeals", A.nav.appeals],
              ["/admin/names", A.nav.names],
            ] as const
          ).map(([href, label]) => (
            <Link key={href} href={href} className="rounded-lg px-3 py-1.5 font-bold hover:bg-muted">
              {label}
            </Link>
          ))}
          <span className="ml-auto text-muted-foreground">{A.signedInAs(admin.reviewer)}</span>
          <form action={logout}>
            <button className="rounded-lg px-3 py-1.5 underline" data-testid="admin-logout">
              {A.logout}
            </button>
          </form>
        </nav>
      )}
      {children}
    </div>
  );
}
