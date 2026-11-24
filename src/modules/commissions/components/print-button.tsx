"use client";

import { Button } from "@/components/ui/button";

/** Opens the browser's print dialog ("Save as PDF" makes the file). Hidden when printing. */
export function CommissionPrintButton({ label }: { label: string }) {
  return (
    <Button type="button" variant="outline" onClick={() => window.print()} className="min-h-11 print:hidden">
      {label}
    </Button>
  );
}
