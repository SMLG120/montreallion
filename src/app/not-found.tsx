import Link from "next/link";
import { getDict } from "@/lib/server/locale";
import { MountainBackdrop } from "@/components/mountain-backdrop";

export default async function NotFound() {
  const t = await getDict();
  return (
    <section className="space-y-5 pt-10 text-center" data-testid="not-found">
      <p className="font-mono text-sm font-bold tracking-[0.3em] text-line-orange">404</p>
      <h1 className="text-4xl font-extrabold">{t.status.notFoundTitle}</h1>
      <p className="mx-auto max-w-md text-muted-foreground">{t.status.notFoundBody}</p>
      <Link href="/" className="inline-flex h-11 items-center rounded-full bg-primary px-5 font-bold text-primary-foreground hover:bg-primary/90">
        {t.status.home}
      </Link>
      <MountainBackdrop className="mt-6 opacity-80" />
    </section>
  );
}
