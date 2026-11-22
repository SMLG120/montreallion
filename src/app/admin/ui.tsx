// Small shared server-rendered pieces for the admin console.
export function Msg({ text, ok }: { text?: string; ok: boolean }) {
  if (!text) return null;
  return (
    <p role="status" data-testid="admin-msg" className={`rounded-lg border px-3 py-2 text-sm ${ok ? "border-[var(--line-green)]" : "border-destructive text-destructive"}`}>
      {text}
    </p>
  );
}

export const inputCls = "h-10 w-full rounded-lg border border-border bg-background px-3 text-sm";
export const btnCls = "inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-bold";
