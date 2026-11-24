"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

/**
 * Light / dark / system theme (next-themes, `class` strategy). next-themes injects
 * one inline script that sets the class before first paint; under the nonce CSP
 * (src/lib/security-headers.ts) that script only runs if it carries this request's
 * nonce, so the root layout passes the nonce the proxy generated.
 */
export function ThemeProvider({ nonce, children }: { nonce: string | undefined; children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="honest-theme"
      nonce={nonce}
    >
      {children}
    </NextThemesProvider>
  );
}
