"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import type { SyncEngine } from "@/lib/offline/sync";
import type { QueueError, QueueItem } from "@/lib/offline/types";
import { CAIRO_DATE_TIME } from "../format";
import { conflictRows, itemActions, statusBadge } from "../logic";
import { ConfirmAction } from "./confirm-action";

/** Translated reason: an offline-specific text for the code if there is one, else the shared errors.* text. */
export function useReason() {
  const t = useTranslations("offline.codes");
  const tErrors = useTranslations("errors");
  return (error: QueueError) =>
    t.has(error.code) ? t(error.code) : tErrors(error.messageKey, { requestId: error.requestId ?? "—" });
}

export function useCommandLabel() {
  const t = useTranslations("offline.commands");
  return (command: string) => (t.has(command) ? t(command) : t("unknown"));
}

export function QueueItemCard({ item, engine, online }: { item: QueueItem; engine: SyncEngine; online: boolean }) {
  const t = useTranslations("offline");
  const format = useFormatter();
  const reason = useReason();
  const commandLabel = useCommandLabel();
  const [busy, setBusy] = useState(false);
  const badge = statusBadge(item);
  const actions = itemActions(item);
  const error = item.lastError;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const replayed = item.status === "done" && typeof item.result === "object" && item.result !== null && !Array.isArray(item.result) && item.result.replayed === true;

  return (
    <Card className="space-y-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h3 className="font-medium">
            {commandLabel(item.command)}
          </h3>
          {item.summary ? <p className="text-sm break-words">{item.summary}</p> : null}
          <p className="text-xs text-muted-foreground">
            <time dateTime={item.createdAt}>{t("item.savedAt", { time: format.dateTime(new Date(item.createdAt), CAIRO_DATE_TIME) })}</time>
            {item.status !== "done" ? <> · {t("item.attempts", { count: item.attempts })}</> : null}
          </p>
        </div>
        <Badge tone={badge.tone}>{t(`status.${badge.key}`)}</Badge>
      </div>

      {badge.key === "stale" ? <p className="text-sm">{t("item.staleHelp")}</p> : null}
      {replayed ? <p className="text-sm text-muted-foreground">{t("item.replayed")}</p> : null}

      {error && item.status !== "done" && item.status !== "conflict" && badge.key !== "stale" ? (
        <p className="text-sm" role={item.status === "failed" ? "alert" : undefined}>
          {t("item.lastError", { reason: reason(error) })}
          {error.requestId ? (
            <span dir="ltr" className="ms-1 text-xs text-muted-foreground">
              ({t("item.reference", { requestId: error.requestId })})
            </span>
          ) : null}
        </p>
      ) : null}

      {item.status === "conflict" ? <ConflictDiff item={item} /> : null}

      {actions.retry || actions.sendAnyway || actions.discard ? (
        <div className="flex flex-wrap gap-2">
          {item.status === "conflict" && engine.canKeepMine(item) ? (
            <Button type="button" disabled={busy || !online} onClick={() => act(() => engine.keepMine(item.id))}>
              {t("actions.keepMine")}
            </Button>
          ) : null}
          {actions.retry ? (
            <Button type="button" variant={item.status === "conflict" ? "outline" : "default"} disabled={busy || !online} onClick={() => act(() => engine.retry(item.id))}>
              {t("actions.retry")}
            </Button>
          ) : null}
          {actions.sendAnyway ? (
            <Button type="button" disabled={busy || !online} onClick={() => act(() => engine.retry(item.id))}>
              {t("actions.sendAnyway")}
            </Button>
          ) : null}
          {actions.discard ? (
            <ConfirmAction
              trigger={item.status === "conflict" ? t("actions.discardMine") : t("actions.discard")}
              question={t("actions.confirmDiscard")}
              confirm={t("actions.confirm")}
              cancel={t("actions.cancel")}
              disabled={busy}
              onConfirm={() => engine.discard(item.id)}
            />
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

/** "Server vs yours", field by field, from the conflict payload (generic: works for any command). */
function ConflictDiff({ item }: { item: QueueItem }) {
  const t = useTranslations("offline.conflict");
  const rows = conflictRows(item);
  const hasServerSide = Boolean(item.lastError?.conflict?.server || item.lastError?.conflict?.currentVersion !== undefined);

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t("title")}</p>
      <p className="text-sm text-muted-foreground">{hasServerSide ? t("help") : t("noDetails")}</p>
      {hasServerSide && rows.length > 0 ? (
        <dl className="divide-y rounded-md border text-sm" aria-label={t("caption")}>
          {rows.map((row) => (
            <div key={row.field} className={row.differs ? "bg-warning/10 p-2" : "p-2"}>
              <dt className="flex flex-wrap items-center gap-2">
                <code dir="ltr" className="text-xs break-all">
                  {row.field}
                </code>
                {row.differs ? <Badge tone="warning">{t("differs")}</Badge> : null}
              </dt>
              <dd className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
                <span className="min-w-0">
                  <span className="text-xs text-muted-foreground">{t("server")}: </span>
                  <bdi className="break-words">{row.server}</bdi>
                </span>
                <span className="min-w-0">
                  <span className="text-xs text-muted-foreground">{t("yours")}: </span>
                  <bdi className="break-words">{row.yours}</bdi>
                </span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
