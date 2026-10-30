import type { ReactNode } from "react";
import { Link } from "@/i18n/navigation";

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
    <Link href={href} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
      {label}
    </Link>
  );
}
