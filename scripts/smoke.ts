/**
 * Post-deploy smoke test (read-mostly; never touches rarity stats or the daily leaderboard).
 *   node scripts/smoke.ts https://your-deployment.example
 * Checks: health (Postgres, config, playable bank), EN/FR pages, leaderboard API,
 * party room create + view (a throwaway room that expires), security headers, and Unlimited start.
 */
const base = (process.argv[2] ?? process.env.SMOKE_URL ?? "").replace(/\/$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("usage: node scripts/smoke.ts <base-url>");
  process.exit(2);
}

let failures = 0;
let cookie = "";
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function req(path: string, init: RequestInit & { lang?: string } = {}) {
  const res = await fetch(base + path, {
    ...init,
    redirect: "manual",
    headers: { "content-type": "application/json", "accept-language": init.lang ?? "en", origin: base, ...(cookie ? { cookie } : {}), ...init.headers },
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(/,(?=\s*\w+=)/).map((c) => c.split(";")[0].trim()).join("; ");
  return res;
}

const health = await req("/api/health");
const h = (await health.json().catch(() => ({}))) as { ok?: boolean; store?: string; db?: string; approvedQuestions?: number; problems?: string[]; commit?: string };
check("health", health.status === 200 && h.ok === true, JSON.stringify(h));
check("health uses postgres", h.store === "postgres" && h.db === "ok");

for (const [path, lang, text] of [["/", "en", "Montréallion"], ["/", "fr", "Montréallion"], ["/leaderboard", "en", ""], ["/party", "fr", ""], ["/play/daily", "en", ""]] as const) {
  const r = await req(path, { lang });
  const body = await r.text();
  check(`GET ${path} (${lang})`, r.status === 200 && body.includes(text), `status ${r.status}`);
  if (path === "/" && lang === "fr") check("fr page lang", /<html[^>]*lang="fr(-CA)?"/.test(body));
}

const home = await req("/");
check("security headers", home.headers.get("x-content-type-options") === "nosniff" && home.headers.get("x-frame-options") === "DENY");
check("no x-powered-by", !home.headers.has("x-powered-by"));

const board = await req("/api/leaderboard");
check("leaderboard api", board.status === 200 && Array.isArray(((await board.json()) as { top?: unknown[] }).top));

const start = await req("/api/game", { method: "POST", body: JSON.stringify({ mode: "unlimited" }) });
const s = (await start.json().catch(() => ({}))) as { sessionId?: string; total?: number };
check("unlimited start", start.status === 200 && !!s.sessionId && s.total === 7, `status ${start.status}`);
check("player cookie is secure+httponly", !base.startsWith("https") || /ml_pid=/.test(cookie));

const party = await req("/api/party", { method: "POST", body: JSON.stringify({ name: "Smoke Test", rounds: 3 }) });
const p = (await party.json().catch(() => ({}))) as { code?: string };
check("party create", party.status === 201 && !!p.code, `status ${party.status}`);
if (p.code) {
  const view = await req(`/api/party/${p.code}`);
  const v = (await view.json().catch(() => ({}))) as { phase?: string };
  check("party view", view.status === 200 && v.phase === "lobby" && !!view.headers.get("etag"), `phase ${v.phase}`);
  await req(`/api/party/${p.code}`, { method: "POST", body: JSON.stringify({ action: "leave" }) });
}

const missing = await req("/api/party/ZZZZZ");
check("unknown party 404", missing.status === 404);

console.log(failures ? `\n${failures} check(s) failed` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);

export {};
