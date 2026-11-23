// SERVER-ONLY: positions of question answers. Imported only by the /api/game/:id/map route.
// Together with question ids this file would be an answer catalog, so it must never reach the client bundle
// or public/. Positions come from each answer's own source record (see etl/montreallion_etl/answer_geo.py).
import geo from "../../../data/generated/answer-geo.json";
import type { Bank } from "./bank";
import type { FrozenScores } from "./store";
import { revealedAnswers, type Session } from "./engine";

type GeoFile = Record<string, Record<string, [number, number, string]>>;
const GEO = geo as unknown as GeoFile;

export type MapPin = {
  round: number;
  role: "matched" | "popular" | "rarest";
  en: string;
  fr: string;
  lon: number;
  lat: number;
};

export type MapRound = { round: number; prompt: { en: string; fr: string }; category: string; located: number };

/** Map pins for a FINISHED session: exactly the answers its results page reveals, when they have a position. */
export function sessionPins(bank: Bank, s: Pick<Session, "submissions" | "frozenScores" | "finishedAt">): { rounds: MapRound[]; pins: MapPin[] } {
  if (s.finishedAt === null) return { rounds: [], pins: [] };
  const pins: MapPin[] = [];
  const rounds: MapRound[] = [];
  s.submissions.forEach((x, round) => {
    const { q, matched, popular, rarest } = revealedAnswers(bank, s.frozenScores as FrozenScores | null, x.questionId, x.answerId);
    const at = GEO[q.id] ?? {};
    const seen = new Set<string>();
    const add = (a: (typeof q.answers)[number] | undefined, role: MapPin["role"]) => {
      if (!a || seen.has(a.id) || !at[a.id]) return;
      seen.add(a.id);
      const [lon, lat] = at[a.id];
      pins.push({ round, role, en: a.en, fr: a.fr ?? a.en, lon, lat });
    };
    add(matched, "matched");
    popular.forEach((a) => add(a, "popular"));
    rarest.forEach((a) => add(a, "rarest"));
    rounds.push({ round, prompt: q.prompt, category: q.category, located: seen.size });
  });
  return { rounds, pins };
}
