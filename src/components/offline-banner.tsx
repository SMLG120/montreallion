"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { WifiOff, Wifi } from "lucide-react";
import { useApp } from "./providers";

const subscribe = (f: () => void) => {
  window.addEventListener("online", f);
  window.addEventListener("offline", f);
  return () => {
    window.removeEventListener("online", f);
    window.removeEventListener("offline", f);
  };
};

/** Fixed (overlay, so no layout shift) notice while the browser reports no connection, and briefly once it's back. */
export function OfflineBanner() {
  const { t } = useApp();
  const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
  const [wasOffline, setWasOffline] = useState(false);
  const [showBack, setShowBack] = useState(false);
  if (!online && !wasOffline) setWasOffline(true);
  if (online && wasOffline) {
    setWasOffline(false);
    setShowBack(true);
  }
  useEffect(() => {
    if (!showBack) return;
    const id = setTimeout(() => setShowBack(false), 3000);
    return () => clearTimeout(id);
  }, [showBack]);

  if (online && !showBack) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4" role="status" aria-live="polite" data-testid={online ? "online-banner" : "offline-banner"}>
      <p className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold shadow-lg ${online ? "bg-forest text-white" : "bg-line-yellow text-[oklch(0.2_0.03_262)]"}`}>
        {online ? <Wifi className="size-4" aria-hidden /> : <WifiOff className="size-4" aria-hidden />}
        {online ? t.status.online : t.status.offline}
      </p>
    </div>
  );
}
