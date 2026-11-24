import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible, Bricolage_Grotesque } from "next/font/google";
import { DICTS } from "@/lib/i18n/dict";
import { getLocale } from "@/lib/server/locale";
import { AppProviders } from "@/components/providers";
import { SiteHeader } from "@/components/site-header";
import { OfflineBanner } from "@/components/offline-banner";
import type { Locale } from "@/lib/game/types";
import "./globals.css";

const display = Bricolage_Grotesque({ variable: "--font-display", subsets: ["latin"], weight: ["500", "700", "800"] });
const body = Atkinson_Hyperlegible({ variable: "--font-body", subsets: ["latin"], weight: ["400", "700"] });

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return {
    title: { default: "Montréallion", template: "%s · Montréallion" },
    description: DICTS[locale].meta.description,
    openGraph: { locale: locale === "fr" ? "fr_CA" : "en_CA", alternateLocale: locale === "fr" ? "en_CA" : "fr_CA" },
  };
}

export const viewport: Viewport = { themeColor: "#151b2b", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Cookie choice first; otherwise the browser's Accept-Language (fr-* → French).
  const locale: Locale = await getLocale();
  return (
    <html lang={locale === "fr" ? "fr-CA" : "en-CA"} className={`${display.variable} ${body.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <AppProviders initialLocale={locale}>
          <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-card focus:px-3 focus:py-2">
            {DICTS[locale].a11y.skip}
          </a>
          <SiteHeader />
          <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 pb-16 pt-6">
            {children}
          </main>
          <OfflineBanner />
        </AppProviders>
      </body>
    </html>
  );
}
