"use client";

import { useSearchParams } from "next/navigation";
import { useId, useTransition, type ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { filterQuery } from "./paging";

/**
 * List filters that live in the URL (the same parameters the pages read before the
 * redesign, so links and bookmarks keep working). A change replaces the URL and
 * goes back to page 1; the server re-validates every value before a query uses it.
 */
function useFilterNav() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const current = new URLSearchParams(searchParams.toString());
  const hrefFor = (patch: Record<string, string | null | undefined>) => {
    const q = filterQuery(current, patch);
    return q ? `${pathname}?${q}` : pathname;
  };
  const go = (patch: Record<string, string | null | undefined>) => startTransition(() => router.replace(hrefFor(patch), { scroll: false }));
  return { current, hrefFor, go, pending };
}

function FilterShell({ id, label, children, className }: { id: string; label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex w-full flex-col gap-1 sm:w-auto sm:min-w-44", className)}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

export interface FilterOption {
  value: string;
  label: string;
}

/** A short list of choices (status, warehouse, type): the phone's own picker. */
export function FilterSelect({
  name,
  label,
  value,
  options,
  allLabel,
  className,
}: {
  name: string;
  label: string;
  value: string | null | undefined;
  options: readonly FilterOption[];
  /** The "no filter" choice; omit when one value is always chosen. */
  allLabel?: string;
  className?: string;
}) {
  const id = useId();
  const nav = useFilterNav();
  return (
    <FilterShell id={id} label={label} className={className}>
      <NativeSelect id={id} value={value ?? ""} aria-busy={nav.pending || undefined} onChange={(e) => nav.go({ [name]: e.target.value || null })} className="w-full">
        {allLabel !== undefined ? <option value="">{allLabel}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    </FilterShell>
  );
}

/** A long list (customers, SKUs): searchable. Choosing the selected one again clears it. */
export function FilterCombobox({
  name,
  label,
  value,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
  className,
}: {
  name: string;
  label: string;
  value: string | null | undefined;
  options: readonly ComboboxOption[];
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  className?: string;
}) {
  const id = useId();
  const nav = useFilterNav();
  return (
    <FilterShell id={id} label={label} className={cn("sm:min-w-56", className)}>
      <Combobox
        id={id}
        options={options}
        value={value ?? null}
        onValueChange={(v) => nav.go({ [name]: v })}
        placeholder={placeholder}
        searchPlaceholder={searchPlaceholder}
        emptyText={emptyText}
        disabled={nav.pending}
      />
    </FilterShell>
  );
}

/** One Cairo calendar day (`YYYY-MM-DD`), e.g. a from/to bound. */
export function FilterDate({
  name,
  label,
  value,
  lang,
  placeholder,
  clearLabel,
  min,
  max,
  className,
}: {
  name: string;
  label: string;
  value: string | null | undefined;
  lang: "ar" | "en";
  placeholder: string;
  clearLabel: string;
  min?: string;
  max?: string;
  className?: string;
}) {
  const id = useId();
  const nav = useFilterNav();
  return (
    <FilterShell id={id} label={label} className={className}>
      <DatePicker id={id} value={value ?? null} onChange={(v) => nav.go({ [name]: v })} lang={lang} placeholder={placeholder} clearLabel={clearLabel} min={min} max={max} disabled={nav.pending} />
    </FilterShell>
  );
}

/**
 * Segmented status filter as links (works before hydration, keeps the other
 * parameters, resets the page). `value: null` is the list's default.
 */
export function FilterTabs({
  name,
  label,
  items,
  current,
  clears = [],
}: {
  name: string;
  label: string;
  items: readonly { value: string | null; text: string }[];
  current: string | null;
  /** Other parameters a tab drops (e.g. the aging bucket, which implies "open"). */
  clears?: readonly string[];
}) {
  const nav = useFilterNav();
  const dropped = Object.fromEntries(clears.map((c) => [c, null]));
  return (
    <nav aria-label={label} className="-mx-1 flex max-w-full gap-1 overflow-x-auto px-1 pb-1">
      {items.map((i) => {
        const active = i.value === current;
        return (
          <Link
            key={i.value ?? "default"}
            href={nav.hrefFor({ ...dropped, [name]: i.value })}
            replace
            scroll={false}
            aria-current={active ? "page" : undefined}
            className={cn(buttonVariants({ variant: active ? "default" : "outline", size: "sm" }), "min-h-11 min-w-11 shrink-0")}
          >
            {i.text}
          </Link>
        );
      })}
    </nav>
  );
}

/** "Clear filters": drops `names` (and the page), keeps everything else. */
export function ClearFilters({ names, label }: { names: readonly string[]; label: string }) {
  const nav = useFilterNav();
  if (!names.some((n) => nav.current.get(n))) return null;
  const patch = Object.fromEntries(names.map((n) => [n, null]));
  return (
    <Link href={nav.hrefFor(patch)} replace scroll={false} className={cn(buttonVariants({ variant: "ghost" }), "self-end")}>
      {label}
    </Link>
  );
}
