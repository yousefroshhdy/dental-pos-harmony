"use client";

import { useEffect } from "react";

/** Registers the app-shell service worker in production (offline queue arrives in Phase 3). */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Non-fatal: the app works online without a service worker.
    });
  }, []);
  return null;
}
