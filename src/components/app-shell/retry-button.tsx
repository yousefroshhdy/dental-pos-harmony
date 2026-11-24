"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "../ui/button";

/** Reloads the current page (the account context is read again on the server). */
export function RetryButton({ label }: { label: string }) {
  return (
    <Button type="button" onClick={() => window.location.reload()}>
      <RefreshCw aria-hidden="true" />
      {label}
    </Button>
  );
}
