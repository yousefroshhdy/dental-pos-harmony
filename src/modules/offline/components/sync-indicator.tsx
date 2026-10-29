"use client";

import { Cloud, CloudOff, RefreshCw, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { countItems } from "../logic";
import { startOfflineDevice } from "../senders";
import { useOfflineQueue } from "../use-offline-queue";
import { SyncQueueView } from "./sync-queue-view";

/**
 * Header indicator: online / offline, syncing, and how many saved items the
 * server has not confirmed yet. Mounting it also starts automatic syncing (app
 * start, `online`, tab visible, every minute), so the app layout renders it
 * once for the signed-in user. It also registers every module's queue senders
 * and deletes other users' queues on this device (../senders.ts):
 *
 *   <SyncIndicator userId={ctx.user_id} />
 *
 * Tapping it opens the pending-sync panel in place. It is a panel, not a link to
 * /sync, because page navigations are never cached (audit #9): offline, /sync
 * would show the static offline page, while this panel runs on code already loaded.
 */
export function SyncIndicator({ userId, className }: { userId: string; className?: string }) {
  const t = useTranslations("offline.indicator");
  // Every page: register all queue senders and wipe other users' queues on this device.
  useEffect(() => startOfflineDevice(userId), [userId]);
  const { items, online, syncing } = useOfflineQueue(userId, { autoSync: true });
  const { unsynced, attention } = countItems(items ?? []);
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  const status = syncing ? t("syncing") : online ? t("online") : t("offline");
  const Icon = syncing ? RefreshCw : online ? Cloud : CloudOff;
  const label = attention > 0 ? t("attentionLabel", { status, count: attention }) : t("label", { status, count: unsynced });

  const show = () => {
    setOpen(true);
    dialog.current?.showModal();
  };
  const close = () => dialog.current?.close();

  return (
    <>
      <button
        type="button"
        onClick={show}
        aria-label={label}
        aria-haspopup="dialog"
        title={label}
        className={cn("relative inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md px-2 hover:bg-muted", className)}
      >
        <Icon
          aria-hidden="true"
          className={cn("size-5", syncing && "animate-spin motion-reduce:animate-none", online ? "text-foreground" : "text-muted-foreground")}
        />
        <span aria-hidden="true" className="hidden text-xs sm:inline">
          {status}
        </span>
        {unsynced > 0 ? (
          <span
            aria-hidden="true"
            className={cn(
              "absolute -top-0.5 -end-0.5 inline-flex min-w-5 items-center justify-center rounded-full px-1 text-[0.625rem] font-semibold tabular-nums",
              attention > 0 ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground",
            )}
          >
            {unsynced > 99 ? "99+" : unsynced}
          </span>
        ) : null}
      </button>

      <dialog
        ref={dialog}
        aria-label={t("panel")}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) close(); // backdrop tap
        }}
        className="m-0 h-dvh max-h-none w-full max-w-none bg-background p-0 text-foreground backdrop:bg-black/40 sm:m-auto sm:h-auto sm:max-h-[85dvh] sm:max-w-lg sm:rounded-lg sm:border"
      >
        {open ? (
          <div className="flex min-h-full flex-col gap-3 px-4 pt-3">
            <div className="flex items-center justify-between gap-2">
              <Link href="/sync" onClick={close} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
                {t("openPage")}
              </Link>
              <Button type="button" variant="ghost" onClick={close} aria-label={t("close")}>
                <X aria-hidden="true" className="size-5" />
              </Button>
            </div>
            <SyncQueueView userId={userId} inPanel />
          </div>
        ) : null}
      </dialog>
    </>
  );
}
