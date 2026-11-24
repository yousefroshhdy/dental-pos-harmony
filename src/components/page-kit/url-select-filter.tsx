"use client";

import { useSearchParams } from "next/navigation";
import { useId, useTransition } from "react";
import { NativeSelect } from "@/components/ui/native-select";
import { usePathname, useRouter } from "@/i18n/navigation";
import { hrefWithParam } from "@/lib/list-query";
import { cn } from "@/lib/utils";

export interface UrlSelectOption {
  /** "" is the "all" option (the parameter is removed). */
  value: string;
  label: string;
}

/**
 * A native select bound to one URL parameter of a server-paged list: choosing an
 * option navigates (back to page 1, search and sort kept). The visible label sits
 * inside the control's accessible name, so a phone reads "Status: Active".
 */
export function UrlSelectFilter({
  label,
  param,
  options,
  className,
}: {
  label: string;
  param: string;
  options: readonly UrlSelectOption[];
  className?: string;
}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const id = useId();
  const value = searchParams.get(param) ?? "";

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <label htmlFor={id} className="shrink-0 text-sm text-muted-foreground">
        {label}
      </label>
      <NativeSelect
        id={id}
        value={value}
        aria-busy={pending || undefined}
        className="min-w-0 flex-1 sm:flex-none"
        onChange={(e) => {
          const params = Object.fromEntries(searchParams.entries());
          const next = hrefWithParam(pathname, params, param, e.target.value === "" ? null : e.target.value);
          startTransition(() => router.replace(next, { scroll: false }));
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
