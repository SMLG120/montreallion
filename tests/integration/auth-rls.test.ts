import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Row-level security on the auth project's profiles table, against a real local Supabase stack
 * (`npm run auth:start`). Uses only the public anon key, as the app does.
 */
const URL = process.env.SUPABASE_TEST_URL;
const KEY = process.env.SUPABASE_TEST_ANON_KEY;

describe.skipIf(!URL || !KEY)("Supabase profiles RLS (integration)", () => {
  const anon = () => createClient(URL!, KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  let a: SupabaseClient;
  let b: SupabaseClient;
  let aId = "";
  let bId = "";

  const signUp = async () => {
    const c = anon();
    const email = `rls-${crypto.randomUUID()}@example.test`;
    const { data, error } = await c.auth.signUp({ email, password: `pw-${crypto.randomUUID()}` });
    if (error || !data.session) throw new Error(`sign-up failed: ${error?.message ?? "no session (email confirmations must be off locally)"}`);
    return { c, id: data.user!.id };
  };

  beforeAll(async () => {
    ({ c: a, id: aId } = await signUp());
    ({ c: b, id: bId } = await signUp());
  });
  afterAll(async () => {
    await a?.auth.signOut();
    await b?.auth.signOut();
  });

  it("creates an empty profile for each new user", async () => {
    const { data } = await a.from("profiles").select("id, display_name, appearance").eq("id", aId).single();
    expect(data).toEqual({ id: aId, display_name: null, appearance: {} });
  });

  it("anonymous visitors can read nothing", async () => {
    const { data, error } = await anon().from("profiles").select("id");
    expect(error ?? data).toSatisfy((x: unknown) => (Array.isArray(x) ? x.length === 0 : true));
  });

  it("a user sees only their own profile", async () => {
    const { data } = await a.from("profiles").select("id");
    expect(data!.map((r) => r.id)).toEqual([aId]);
    const { data: other } = await a.from("profiles").select("id").eq("id", bId);
    expect(other).toEqual([]);
  });

  it("a user can update their own name and look, and nobody else's", async () => {
    const own = await a.from("profiles").update({ display_name: "Ana", appearance: { hat: "cap" } }).eq("id", aId).select("display_name, appearance");
    expect(own.data).toEqual([{ display_name: "Ana", appearance: { hat: "cap" } }]);
    const theirs = await a.from("profiles").update({ display_name: "Hacked" }).eq("id", bId).select("id");
    expect(theirs.data ?? []).toEqual([]);
    const { data } = await b.from("profiles").select("display_name").eq("id", bId).single();
    expect(data!.display_name).toBeNull();
  });

  it("protected columns, inserts and deletes are refused", async () => {
    expect((await a.from("profiles").update({ id: bId }).eq("id", aId)).error).not.toBeNull();
    expect((await a.from("profiles").update({ created_at: "2000-01-01" }).eq("id", aId)).error).not.toBeNull();
    expect((await a.from("profiles").insert({ id: crypto.randomUUID() })).error).not.toBeNull();
    await a.from("profiles").delete().eq("id", aId);
    expect((await a.from("profiles").select("id").eq("id", aId)).data).toHaveLength(1);
  });

  it("rejects oversized or non-object appearance and bad names", async () => {
    expect((await a.from("profiles").update({ appearance: { x: "y".repeat(5000) } }).eq("id", aId)).error).not.toBeNull();
    expect((await a.from("profiles").update({ appearance: ["array"] }).eq("id", aId)).error).not.toBeNull();
    expect((await a.from("profiles").update({ display_name: "x" }).eq("id", aId)).error).not.toBeNull();
  });

  it("profiles never carry email addresses", async () => {
    const { data, error } = await a.from("profiles").select("*").eq("id", aId).single();
    expect(error).toBeNull();
    expect(Object.keys(data!).some((k) => /mail/i.test(k))).toBe(false);
  });
});
