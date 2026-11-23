import type { Metadata } from "next";
import { getDict } from "@/lib/server/locale";
import { MapView } from "@/components/map/map-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getDict();
  return { title: t.map.title, description: t.map.intro };
}

export default async function Page({ searchParams }: PageProps<"/map">) {
  const raw = (await searchParams).game;
  // Only a well-formed session id is passed on; the API decides what (if anything) it may reveal.
  const game = typeof raw === "string" && /^[0-9a-f-]{36}$/i.test(raw) ? raw : null;
  return <MapView game={game} />;
}
