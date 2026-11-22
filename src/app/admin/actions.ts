"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { reviewQuestion, resolveAppeal, resetName } from "@/lib/server/admin-data";
import { clearAdminCookie, requireAdmin, setAdminCookie, tokenMatches } from "@/lib/server/admin-auth";
import { getSql } from "@/lib/server/db";
import { rateLimit } from "@/lib/server/http";

// Every action re-checks the admin cookie: actions are public POST endpoints (Next checks Origin for CSRF).

function db() {
  const sql = getSql();
  if (!sql) redirect("/admin");
  return sql;
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "");

export async function login(form: FormData) {
  if (!(await rateLimit("admin-login", 5))) redirect("/admin/login?error=rate");
  const reviewer = str(form, "reviewer").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!reviewer || !tokenMatches(str(form, "token"))) redirect("/admin/login?error=bad");
  await setAdminCookie(reviewer);
  redirect("/admin");
}

export async function logout() {
  await clearAdminCookie();
  redirect("/admin/login");
}

const reviewSchema = z.object({
  id: z.string().min(1).max(200),
  status: z.enum(["approved", "rejected", "in_review"]),
  note: z.string().max(500),
  hash: z.string().min(1).max(64),
});

export async function review(form: FormData) {
  const { reviewer } = await requireAdmin();
  const p = reviewSchema.safeParse({ id: str(form, "id"), status: str(form, "status"), note: str(form, "note").trim(), hash: str(form, "hash") });
  if (!p.success) redirect("/admin/questions");
  const r = await reviewQuestion(db(), p.data.id, p.data.status, reviewer, p.data.note, p.data.hash);
  redirect(`/admin/questions/${encodeURIComponent(p.data.id)}?msg=${r}`);
}

const resolveSchema = z.object({
  id: z.coerce.number().int().positive(),
  action: z.enum(["alias", "noted", "rejected"]),
  answer: z.string().max(200),
  note: z.string().max(500),
});

export async function resolve(form: FormData) {
  const { reviewer } = await requireAdmin();
  const p = resolveSchema.safeParse({ id: str(form, "id"), action: str(form, "action"), answer: str(form, "answer"), note: str(form, "note").trim() });
  if (!p.success) redirect("/admin/appeals?msg=not_found");
  const r = await resolveAppeal(db(), p.data.id, p.data.action, reviewer, p.data.note, p.data.answer || undefined);
  redirect(`/admin/appeals?msg=${r}#appeal-${p.data.id}`);
}

export async function clearName(form: FormData) {
  await requireAdmin();
  const id = str(form, "player");
  if (!/^[0-9a-f-]{36}$/.test(id)) redirect("/admin/names");
  await resetName(db(), id);
  redirect("/admin/names?msg=ok");
}
