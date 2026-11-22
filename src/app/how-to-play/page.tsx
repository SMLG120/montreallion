import { getDict } from "@/lib/server/locale";
import type { Metadata } from "next";
import { HowToPlayView } from "@/components/pages/static-views";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getDict();
  return { title: t.nav.how };
}

export default function Page() {
  return <HowToPlayView />;
}
