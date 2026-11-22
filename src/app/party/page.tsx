import type { Metadata } from "next";
import { PartyHome } from "@/components/party/party-home";
import { getBank } from "@/lib/game/bank";
import { MIN_CATEGORY_QUESTIONS } from "@/lib/game/engine";
import { CATEGORY_IDS } from "@/lib/game/types";
import { getDict } from "@/lib/server/locale";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getDict()).party.title };
}

export default async function Page({ searchParams }: PageProps<"/party">) {
  const bank = await getBank();
  const categories = CATEGORY_IDS.filter((id) => bank.questions.filter((q) => q.category === id).length >= MIN_CATEGORY_QUESTIONS);
  const code = (await searchParams).code;
  return <PartyHome categories={categories} initialCode={typeof code === "string" ? code.toUpperCase().slice(0, 5) : ""} />;
}
