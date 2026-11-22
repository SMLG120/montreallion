import { getDict } from "@/lib/server/locale";
import type { Metadata } from "next";
import { LeaderboardView } from "@/components/pages/leaderboard-view";
import { boardDate, getBoard } from "@/lib/game/board";
import { getPlayerId } from "@/lib/server/http";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getDict();
  return { title: t.nav.leaderboard };
}

export default async function Page({ searchParams }: PageProps<"/leaderboard">) {
  const raw = (await searchParams).date;
  const date = boardDate(typeof raw === "string" ? raw : null);
  return <LeaderboardView board={await getBoard(date, await getPlayerId(false))} />;
}
