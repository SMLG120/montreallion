import { Loader2 } from "lucide-react";
import { getDict } from "@/lib/server/locale";

export default async function Loading() {
  const t = await getDict();
  return (
    <div className="grid min-h-[50vh] place-items-center" role="status" aria-live="polite">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" aria-hidden /> {t.status.loading}
      </p>
    </div>
  );
}
