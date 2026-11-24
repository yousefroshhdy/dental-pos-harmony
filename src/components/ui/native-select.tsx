import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A styled native `<select>`: works in server-rendered forms and without JavaScript,
 * and phones show their own picker. Prefer it for short static lists; use `Select`
 * (select.tsx) for styled options and `Combobox` when the list needs search.
 * primitives.tsx re-exports it as `Select` for the screens written before Phase P.
 */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "min-h-11 rounded-md border border-input bg-card px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}
