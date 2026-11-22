import { getDict } from "@/lib/server/locale";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GameClient } from "@/components/game/game-client";
import { CATEGORY_IDS, type CategoryId } from "@/lib/game/types";

export async function generateMetadata({ params }: PageProps<"/play/[mode]">): Promise<Metadata> {
  const [t, { mode }] = await Promise.all([getDict(), params]);
  return { title: mode === "daily" ? t.nav.daily : mode === "unlimited" ? t.nav.unlimited : t.meta.play };
}

export default async function PlayPage({ params, searchParams }: PageProps<"/play/[mode]">) {
  const { mode } = await params;
  if (mode !== "daily" && mode !== "unlimited") notFound();
  const raw = (await searchParams).category;
  const category = mode === "unlimited" && (CATEGORY_IDS as readonly string[]).includes(String(raw)) ? (raw as CategoryId) : undefined;
  return <GameClient key={`${mode}:${category ?? ""}`} mode={mode} category={category} />;
}
