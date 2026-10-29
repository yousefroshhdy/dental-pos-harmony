import type { ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import type { Option } from "../logic";

export type FilterField =
  | { kind: "select"; name: string; label: string; value?: string; options: Option[]; allLabel: string }
  | { kind: "date"; name: string; label: string; value?: string };

/**
 * A GET filter form (works without JS; the URL is shareable). Values are
 * re-validated on the server by parse*Filters before they reach a query.
 */
export function FilterBar({
  fields,
  hidden,
  applyLabel,
  resetLabel,
  resetHref,
  children,
}: {
  fields: FilterField[];
  hidden?: Record<string, string | undefined>;
  applyLabel: string;
  resetLabel: string;
  resetHref: string;
  children?: ReactNode;
}) {
  return (
    <form method="get" className="grid gap-3 rounded-lg border bg-card p-3 sm:grid-cols-2 lg:grid-cols-4">
      {Object.entries(hidden ?? {}).map(([name, value]) => (value ? <input key={name} type="hidden" name={name} value={value} /> : null))}
      {fields.map((f) => (
        <div key={f.name} className="space-y-1">
          <Label htmlFor={`filter-${f.name}`} className="text-xs text-muted-foreground">
            {f.label}
          </Label>
          {f.kind === "select" ? (
            <Select id={`filter-${f.name}`} name={f.name} defaultValue={f.value ?? ""} className="w-full">
              <option value="">{f.allLabel}</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input id={`filter-${f.name}`} name={f.name} type="date" dir="ltr" defaultValue={f.value ?? ""} />
          )}
        </div>
      ))}
      {children}
      <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
        <Button type="submit" className="flex-1 sm:flex-none">
          {applyLabel}
        </Button>
        <Link href={resetHref} className={buttonVariants({ variant: "ghost" })}>
          {resetLabel}
        </Link>
      </div>
    </form>
  );
}
