"use client";

import { Lock } from "lucide-react";
import { useApp } from "@/components/providers";
import { LOOK_PARTS, type Appearance, type Need, type Part } from "@/lib/game/climb";

/** Character customization: one row per layer. Locked items show what unlocks them and can't be picked. */
export function LookEditor({ look, allowed, onChange, parts }: { look: Appearance; allowed: Set<Need>; onChange: (l: Appearance) => void; parts?: Part[] }) {
  const { t } = useApp();
  const tc = t.climb;
  const list = parts ?? (Object.keys(LOOK_PARTS) as Part[]);
  return (
    <div className="grid gap-3 text-sm" data-testid="look-editor">
      {list.map((part) => (
        <fieldset key={part} className="flex flex-wrap items-center gap-2">
          <legend className="mb-1 text-xs font-bold">{tc.parts[part]}</legend>
          {LOOK_PARTS[part].map((o, i) => {
            const locked = !allowed.has(o.need);
            const on = look[part] === o.id;
            const name = o.color ? tc.swatch(tc.parts[part], i + 1) : (tc.items[o.id] ?? o.id);
            const why = locked ? tc.unlock[o.need] : undefined;
            const common = {
              type: "button" as const,
              disabled: locked,
              "aria-pressed": on,
              "aria-label": why ? `${name} — ${why}` : name,
              title: why ?? name,
              onClick: () => onChange({ ...look, [part]: o.id }),
              "data-testid": `look-${part}-${o.id}`,
              "data-locked": locked ? "1" : "0",
            };
            return o.color ? (
              <button key={o.id} {...common} className={`relative size-9 rounded-full border-2 ${on ? "border-foreground" : "border-border"} disabled:opacity-40`} style={{ background: o.color }}>
                {locked && <Lock className="absolute inset-0 m-auto size-3.5 text-white drop-shadow" aria-hidden />}
              </button>
            ) : (
              <button key={o.id} {...common} className={`inline-flex min-h-9 items-center gap-1 rounded-lg border px-3 text-xs font-semibold ${on ? "border-foreground bg-muted" : "border-border"} disabled:opacity-50`}>
                {locked && <Lock className="size-3" aria-hidden />}
                {name}
              </button>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
