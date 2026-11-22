import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PartyRoom } from "@/components/party/party-room";
import { CODE_RE } from "@/lib/game/party";
import { getDict } from "@/lib/server/locale";

export async function generateMetadata({ params }: PageProps<"/party/[code]">): Promise<Metadata> {
  const [t, { code }] = await Promise.all([getDict(), params]);
  return { title: `${t.party.title} · ${code.toUpperCase()}`, robots: { index: false } };
}

export default async function Page({ params }: PageProps<"/party/[code]">) {
  const code = (await params).code.toUpperCase();
  if (!CODE_RE.test(code)) notFound();
  return <PartyRoom code={code} />;
}
