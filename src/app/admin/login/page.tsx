import { redirect } from "next/navigation";
import { adminEnabled, getAdmin } from "@/lib/server/admin-auth";
import { getDict } from "@/lib/server/locale";
import { login } from "../actions";
import { btnCls, inputCls, Msg } from "../ui";

export default async function AdminLogin({ searchParams }: PageProps<"/admin/login">) {
  const t = await getDict();
  const A = t.admin;
  if (!adminEnabled()) redirect("/admin");
  if (await getAdmin()) redirect("/admin");
  const { error } = await searchParams;
  return (
    <form action={login} className="mx-auto max-w-sm space-y-4 py-8">
      <h1 className="text-4xl font-extrabold">{A.title}</h1>
      <Msg ok={false} text={error === "rate" ? t.game.rateLimited : error ? A.badLogin : undefined} />
      <label className="block space-y-1 text-sm font-bold">
        <span>{A.reviewer}</span>
        <input name="reviewer" required maxLength={40} autoComplete="name" className={inputCls} data-testid="admin-reviewer" />
      </label>
      <label className="block space-y-1 text-sm font-bold">
        <span>{A.token}</span>
        <input name="token" type="password" required autoComplete="current-password" className={inputCls} data-testid="admin-token" />
      </label>
      <button className={`${btnCls} w-full bg-primary text-primary-foreground`} data-testid="admin-login">
        {A.login}
      </button>
    </form>
  );
}
