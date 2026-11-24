"use client";

import { Check, Lock } from "lucide-react";
import { useApp } from "@/components/providers";
import { LOOK_PARTS, type Appearance, type Need, type Part } from "@/lib/game/climb";

/** Character customization: one row per layer. Locked items say what unlocks them and can't be picked. */
export function LookEditor({ look, allowed, onChange, parts }: { look: Appearance; allowed: Set<Need>; onChange: (l: Appearance) => void; parts?: Part[] }) {
  const { t } = useApp();
  const tc = t.climb;
  const list = parts ?? (Object.keys(LOOK_PARTS) as Part[]);
  return (
    <div className="grid gap-4 text-sm" data-testid="look-editor">
      {list.map((part) => {
        const lockedHere = LOOK_PARTS[part].filter((o) => !allowed.has(o.need));
        return (
          <fieldset key={part} className="space-y-2">
            <legend className="mb-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">{tc.parts[part]}</legend>
            <div className="flex flex-wrap items-center gap-2">
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
                  <button
                    key={o.id}
                    {...common}
                    className={`relative size-10 rounded-full border-2 transition-transform enabled:hover:scale-110 enabled:active:scale-95 ${on ? "border-primary ring-2 ring-primary/40 ring-offset-2 ring-offset-card" : "border-border"} disabled:opacity-40`}
                    style={{ background: o.color }}
                  >
                    {locked && <Lock className="absolute inset-0 m-auto size-3.5 text-white drop-shadow" aria-hidden />}
                    {on && <Check className="absolute -right-1 -top-1 size-4 rounded-full bg-primary p-0.5 text-primary-foreground" aria-hidden />}
                  </button>
                ) : (
                  <button
                    key={o.id}
                    {...common}
                    className={`inline-flex min-h-10 items-center gap-1 rounded-xl border px-3 text-xs font-semibold transition-colors enabled:active:scale-95 ${on ? "border-primary bg-primary/15 text-foreground" : "border-border enabled:hover:bg-muted"} disabled:border-dashed disabled:opacity-60`}
                  >
                    {locked ? <Lock className="size-3" aria-hidden /> : on ? <Check className="size-3.5 text-primary" aria-hidden /> : null}
                    {name}
                  </button>
                );
              })}
            </div>
            {lockedHere.length > 0 && (
              <ul className="space-y-0.5 text-[11px] text-muted-foreground" aria-hidden>
                {lockedHere.map((o) => (
                  <li key={o.id} className="flex items-center gap-1">
                    <Lock className="size-2.5 shrink-0" />
                    <span className="font-semibold">{o.color ? tc.swatch(tc.parts[part], LOOK_PARTS[part].indexOf(o) + 1) : (tc.items[o.id] ?? o.id)}</span>
                    <span>· {tc.unlock[o.need]}</span>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}
