"use client";

import { useEffect } from "react";
import { stopNativeTracking } from "@/lib/native/background-geolocation";

/**
 * Nobody is signed in on the login page, so nothing may be collected: inside the
 * Android shell, remove any background-location watcher left by the previous session
 * (sign-out, an expired session, a reload). Renders nothing; a no-op in browsers.
 */
export function NativeTrackingStop() {
  useEffect(() => {
    void stopNativeTracking();
  }, []);
  return null;
}
