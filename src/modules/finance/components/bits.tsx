import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

/** Label/value pair for detail cards. */
export function Field({ label, value, dir }: { label: string; value: ReactNode; dir?: "ltr" | "rtl" }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="break-words font-medium" dir={dir}>
        {value}
      </div>
    </div>
  );
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline print:hidden">
      {label}
    </Link>
  );
}

/** A row of filter links (no JS); the current one is marked for assistive tech. */
export function FilterLinks({ label, items }: { label: string; items: { key: string; href: string; text: string; current: boolean }[] }) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-2">
      {items.map((i) => (
        <Link
          key={i.key}
          href={i.href}
          aria-current={i.current ? "page" : undefined}
          className={cn(buttonVariants({ variant: i.current ? "default" : "outline", size: "sm" }), "min-h-11")}
        >
          {i.text}
        </Link>
      ))}
    </nav>
  );
}
