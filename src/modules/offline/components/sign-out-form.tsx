"use client";

import { useTranslations } from "next-intl";
import { useRef, type FormEvent, type ReactNode } from "react";
import { clearForUser, countUnsynced } from "@/lib/offline/client";
import { STORAGE_PREFIX as TRACKING_STORAGE_PREFIX } from "@/modules/tracking/device-store";

/**
 * Sign-out form that wipes this user's offline queue from the device first
 * (shared field devices), after warning when unsynced items would be lost.
 * Drop-in replacement for the layout's `<form action={signOutAction}>`:
 *
 *   <OfflineSignOutForm userId={ctx.user_id} action={signOutAction}>
 *     <Button variant="ghost" size="sm">{t("signOut")}</Button>
 *   </OfflineSignOutForm>
 */
export function OfflineSignOutForm({
  userId,
  action,
  children,
}: {
  userId: string;
  action: (formData: FormData) => void | Promise<void>;
  children: ReactNode;
}) {
  const t = useTranslations("offline.signOut");
  const form = useRef<HTMLFormElement>(null);
  const cleared = useRef(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (cleared.current) return; // second pass: let the server action run
    event.preventDefault();
    void (async () => {
      try {
        const unsynced = await countUnsynced(userId);
        if (unsynced > 0 && !window.confirm(t("unsyncedWarning", { count: unsynced }))) return;
        await clearForUser(userId);
        // Work-hours tracking keeps its open shift and unsent points in localStorage (D-14).
        window.localStorage.removeItem(TRACKING_STORAGE_PREFIX + userId);
      } catch {
        // Storage unavailable: nothing was stored on this device to leak.
      }
      cleared.current = true;
      form.current?.requestSubmit();
    })();
  };

  return (
    <form ref={form} action={action} onSubmit={onSubmit}>
      {children}
    </form>
  );
}
