"use client";

import { useTheme } from "next-themes";
import type { CSSProperties } from "react";
import { Toaster as Sonner, toast, type ToasterProps } from "sonner";

/**
 * Toasts (sonner). The app shell mounts one <Toaster/>; anything client-side calls
 * `toast.success(t("saved"))`, `toast.error(...)`. Toasts are for confirmations
 * only: an error a user must act on belongs inline next to the field or form.
 * Sonner announces each toast in an aria-live region.
 */
export function Toaster({ dir, ...props }: ToasterProps) {
  const { resolvedTheme } = useTheme();
  return (
    <Sonner
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      dir={dir}
      position="top-center"
      closeButton
      richColors
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          fontFamily: "var(--app-font)",
        } as CSSProperties
      }
      {...props}
    />
  );
}

export { toast };
