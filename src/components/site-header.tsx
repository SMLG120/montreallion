"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Volume2, VolumeX } from "lucide-react";
import { useApp } from "./providers";
import { cn } from "@/lib/utils";

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-heading font-extrabold tracking-tight", className)}>
      <svg viewBox="0 0 32 32" className="size-[1.4em]" aria-hidden>
        <circle cx="16" cy="16" r="15" fill="var(--tile)" />
        <path d="M7 23V10l9 8 9-8v13" fill="none" stroke="oklch(0.2 0.03 262)" strokeWidth="3.2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx="7" cy="23" r="2.4" fill="var(--line-green)" />
        <circle cx="16" cy="18" r="2.4" fill="var(--line-orange)" />
        <circle cx="25" cy="23" r="2.4" fill="var(--line-blue)" />
      </svg>
      <span>
        Montr<span className="text-line-orange">é</span>allion
      </span>
    </span>
  );
}

export function SiteHeader() {
  const { t, locale, setLocale, sound, setSound } = useApp();
  const path = usePathname();
  const links = [
    { href: "/play/daily", label: t.nav.daily },
    { href: "/play/unlimited", label: t.nav.unlimited },
    { href: "/party", label: t.nav.party },
    { href: "/leaderboard", label: t.nav.leaderboard },
    { href: "/how-to-play", label: t.nav.how },
  ];
  return (
    <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-3xl items-center gap-3 px-4">
        <Link href="/" className="text-lg" aria-label={t.a11y.home}>
          <Wordmark />
        </Link>
        <nav className="ml-auto hidden items-center gap-1 sm:flex" aria-label={t.a11y.mainNav}>
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
                path === l.href && "bg-muted text-foreground",
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:ml-2">
          <button
            type="button"
            onClick={() => setSound(!sound)}
            className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-pressed={sound}
            aria-label={sound ? t.sound.on : t.sound.off}
            title={sound ? t.sound.on : t.sound.off}
          >
            {sound ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
          </button>
          <button
            type="button"
            onClick={() => setLocale(locale === "en" ? "fr" : "en")}
            className="h-9 rounded-md border border-border px-2.5 text-sm font-semibold hover:bg-muted"
            lang={locale === "en" ? "fr" : "en"}
            data-testid="lang-switch"
          >
            {locale === "en" ? "FR" : "EN"}
            <span className="sr-only"> — {t.langSwitch}</span>
          </button>
        </div>
      </div>
      <nav className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-3 pb-2 sm:hidden" aria-label={t.a11y.mainNav}>
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={cn(
              "shrink-0 rounded-full px-3 py-1 text-xs text-muted-foreground",
              path === l.href ? "bg-muted text-foreground" : "border border-border/70",
            )}
          >
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
