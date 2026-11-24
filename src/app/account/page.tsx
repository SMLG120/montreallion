import type { Metadata } from "next";
import { getDict } from "@/lib/server/locale";
import { AccountView } from "@/components/pages/account-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getDict();
  return { title: t.account.title, robots: { index: false } };
}

export default function Page() {
  return <AccountView />;
}
