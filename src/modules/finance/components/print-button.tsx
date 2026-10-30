"use client";

import { Button } from "@/components/ui/button";

/** Opens the browser's print dialog (the statement has print styles). Hidden when printing. */
export function PrintButton({ label }: { label: string }) {
  return (
    <Button type="button" variant="outline" onClick={() => window.print()} className="print:hidden">
      {label}
    </Button>
  );
}
