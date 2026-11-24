"use client";

import Link from "next/link";
import { useEffect } from "react";
import { RotateCw } from "lucide-react";
import { useApp } from "@/components/providers";
import { Button } from "@/components/ui/button";

/** Route-level error boundary: keeps the header and theme, offers a retry. No error details are shown to players. */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useApp();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <section className="space-y-5 pt-10 text-center" role="alert" data-testid="route-error">
      <h1 className="text-3xl font-extrabold">{t.status.errorTitle}</h1>
      <p className="mx-auto max-w-md text-muted-foreground">{t.status.errorBody}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={reset} className="h-11 rounded-full px-5 font-bold">
          <RotateCw aria-hidden /> {t.status.retry}
        </Button>
        <Link href="/" className="inline-flex h-11 items-center rounded-full border border-border px-5 font-bold hover:bg-muted">
          {t.status.home}
        </Link>
      </div>
    </section>
  );
}
