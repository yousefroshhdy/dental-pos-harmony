import type { ReactNode } from "react";
import { Card, CardTitle } from "@/components/ui/card";

/** A numbered builder section (customer, offers, products, lines, discount). */
export function Section({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <Card className="space-y-3">
      <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
        <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary tabular-nums">
          {step}
        </span>
        {title}
      </CardTitle>
      {children}
    </Card>
  );
}
