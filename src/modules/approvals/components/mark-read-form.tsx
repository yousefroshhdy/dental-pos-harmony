"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { markAllNotificationsRead, markNotificationsRead } from "../actions";
import { ActionMessage } from "./action-message";

/** Marks one notification (or a list) as read. The command only touches the caller's own rows. */
export function MarkReadForm({ ids, label }: { ids: string[]; label: string }) {
  const [state, formAction, pending] = useActionState(markNotificationsRead, null);
  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <input type="hidden" name="ids" value={ids.join(",")} />
      <Button type="submit" variant="outline" size="sm" className="min-h-11" disabled={pending}>
        {label}
      </Button>
      <ActionMessage state={state} />
    </form>
  );
}

export function MarkAllReadForm() {
  const t = useTranslations("approvals.notifications");
  const [state, formAction, pending] = useActionState(markAllNotificationsRead, null);
  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <Button type="submit" variant="outline" disabled={pending}>
        {t("markAllRead")}
      </Button>
      <ActionMessage state={state} />
    </form>
  );
}
