import { getDict } from "@/lib/server/locale";
import type { Metadata } from "next";
import { getBank } from "@/lib/game/bank";
import { engine, summarize } from "@/lib/game/engine";
import { defaultStore } from "@/lib/game/store";
import { appealsForSession } from "@/lib/server/appeals";
import { getSql } from "@/lib/server/db";
import { getPlayerId } from "@/lib/server/http";
import { ResultsView } from "@/components/pages/results-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getDict();
  return { title: t.meta.results };
}

export default async function ResultsPage({ params }: PageProps<"/results/[id]">) {
  const { id } = await params;
  const s = await engine.get(id);
  // Only finished sessions are viewable, so answers never leak mid-game.
  if (!s || s.finishedAt === null) return <ResultsView summary={null} board={null} appeals={null} />;
  const store = await defaultStore();
  const sql = getSql();
  // Appeals are only offered to the session's owner, and only when there's a database to store them.
  const owner = (await getPlayerId(false)) === s.playerId;
  const [bank, day, board] = await Promise.all([
    getBank(),
    s.dateKey ? store.dailyCounts(s.dateKey) : null,
    s.dateKey ? store.leaderboard(s.dateKey, s.playerId, 0) : null,
  ]);
  const appeals = owner && sql ? await appealsForSession(sql, s.id, s.playerId) : null;
  // Rank is the session owner's, shown to anyone holding the link; no ids are exposed.
  return <ResultsView summary={summarize(bank, s, day)} board={board ? { rank: board.you?.rank ?? null, players: board.players } : null} appeals={appeals} />;
}
