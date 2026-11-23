import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import geo from "../../data/generated/answer-geo.json";
import generated from "../../data/generated/questions.generated.json";
import { seedBank } from "@/lib/game/bank";
import { revealFor, type Session } from "@/lib/game/engine";
import { sessionPins } from "@/lib/game/answer-geo";

const GEO = geo as unknown as Record<string, Record<string, [number, number, string]>>;
const questions = new Map((generated as { questions: { id: string; scope: string; answers: { id: string }[] }[] }).questions.map((q) => [q.id, q]));

describe("answer-geo (server-only answer positions)", () => {
  it("only references existing questions/answers, with sane coordinates and a basis", () => {
    let n = 0;
    for (const [qid, answers] of Object.entries(GEO)) {
      const q = questions.get(qid);
      expect(q, qid).toBeTruthy();
      const ids = new Set(q!.answers.map((a) => a.id));
      for (const [slug, [lon, lat, basis]] of Object.entries(answers)) {
        expect(ids.has(slug), `${qid}:${slug}`).toBe(true);
        expect(basis).toMatch(/^(mtl-|gtfs|wikidata-P625|osm)/);
        if (q!.scope === "province") {
          expect(lon).toBeGreaterThan(-80);
          expect(lon).toBeLessThan(-57);
        } else {
          // Greater Montréal box.
          expect(lon).toBeGreaterThan(-74.4);
          expect(lon).toBeLessThan(-73.1);
          expect(lat).toBeGreaterThan(45.2);
          expect(lat).toBeLessThan(45.95);
        }
        n++;
      }
    }
    expect(n).toBeGreaterThan(4000);
  });

  it("is never imported by client code or copied to public/", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|mjs|js)$/.test(f)) {
          const src = readFileSync(p, "utf8");
          // Value imports only: `import type` is erased at compile time and ships nothing.
          const importsGeo = /^import\s+(?!type\b)[^;]*from\s+["'][^"']*answer-geo(\.json)?["']/m.test(src);
          if (importsGeo && (src.startsWith('"use client"') || src.startsWith("'use client'"))) offenders.push(p);
          if (importsGeo && !/src\/(app\/api\/game\/\[id\]\/map\/route\.ts|lib\/game\/answer-geo\.ts)$/.test(p)) offenders.push(p);
        }
      }
    };
    walk(join(process.cwd(), "src"));
    expect(offenders).toEqual([]);
    expect(readdirSync(join(process.cwd(), "public", "map")).some((f) => f.includes("answer"))).toBe(false);
  });
});

describe("sessionPins (map pins for a finished ride)", () => {
  const bank = seedBank();
  const located = bank.questions.filter((q) => Object.keys(GEO[q.id] ?? {}).length >= 5).slice(0, 7);

  const session = (finished: boolean) =>
    ({
      finishedAt: finished ? Date.now() : null,
      frozenScores: null,
      submissions: located.map((q, i) => ({ questionId: q.id, answerId: i % 2 ? q.answers[q.answers.length - 1].id : null })),
    }) as unknown as Session;

  it("has approved questions with positions to test against", () => {
    expect(located.length).toBeGreaterThanOrEqual(3);
  });

  it("returns nothing for an unfinished ride", () => {
    expect(sessionPins(bank, session(false))).toEqual({ rounds: [], pins: [] });
  });

  it("returns only the answers the results page reveals (≤ 6 per stop), with no ids or scores", () => {
    const s = session(true);
    const { rounds, pins } = sessionPins(bank, s);
    expect(rounds).toHaveLength(located.length);
    s.submissions.forEach((x, i) => {
      const r = revealFor(bank, null, x.questionId, x.answerId);
      const allowed = new Set([r.matched?.en, ...r.popular.map((a) => a.en), ...r.rarest.map((a) => a.en)].filter(Boolean));
      const mine = pins.filter((p) => p.round === i);
      expect(mine.length).toBeLessThanOrEqual(6);
      for (const p of mine) expect(allowed.has(p.en), p.en).toBe(true);
    });
    const json = JSON.stringify({ rounds, pins });
    for (const key of ["id", "score", "est", "tier", "aliases", "refs", "share", "answerId"]) expect(json).not.toContain(`"${key}":`);
  });
});
