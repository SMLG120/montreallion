import type { Metadata } from "next";
import { getDict } from "@/lib/server/locale";
import { AccountView } from "@/components/pages/account-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getDict();
  return { title: t.account.title, robots: { index: false } };
}

export default async function Page({ searchParams }: PageProps<"/account">) {
  const q = await searchParams;
  const notice = q.error === "link" ? "link" : q.welcome === "1" ? "welcome" : null;
  return <AccountView notice={notice} />;
}
