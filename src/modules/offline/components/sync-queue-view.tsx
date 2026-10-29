"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import type { SyncEngine, SyncReport } from "@/lib/offline/sync";
import type { QueueItem } from "@/lib/offline/types";
import { cn } from "@/lib/utils";
import { countItems, groupItems } from "../logic";
import { useOfflineQueue } from "../use-offline-queue";
import { QueueItemCard } from "./queue-item-card";

/**
 * The pending-sync body: what this device still has to send, what needs a
 * decision (failed, conflict, older than 7 days), and what synced recently.
 * Used by the /sync page and, so it also works offline, by the header
 * indicator's panel (navigations are never cached — audit #9 — so the /sync
 * page itself cannot open while offline). Everything here is local to the
 * device; Postgres re-checks every command when it is sent.
 */
export function SyncQueueView({ userId, inPanel = false }: { userId: string; inPanel?: boolean }) {
  const t = useTranslations("offline");
  const { engine, items, loadFailed, syncing, online, persistent, lastReport, syncNow } = useOfflineQueue(userId);
  const Heading = inPanel ? "h2" : "h1";

  const groups = groupItems(items ?? []);
  const counts = countItems(items ?? []);
  const canSync = online && !syncing && counts.unsynced > 0;

  return (
    <div className={cn("space-y-4", !inPanel && "pb-24 sm:pb-0")}>
      <div className="space-y-1">
        <Heading className={inPanel ? "text-xl font-semibold" : "text-2xl font-semibold"}>{t("page.title")}</Heading>
        <p className="text-sm text-muted-foreground">{t("page.description")}</p>
      </div>

      {!online ? (
        <Alert tone="info" role="status">
          {t("page.offlineNotice")}
        </Alert>
      ) : null}
      {!persistent ? <Alert tone="info">{t("page.memoryOnly")}</Alert> : null}
      {loadFailed ? <Alert>{items ? t("report.error") : t("page.loadError")}</Alert> : lastReport ? <ReportLine report={lastReport} /> : null}

      {/* Primary action: pinned to the bottom on phones (and in the panel), inline on larger pages. */}
      <div
        className={cn(
          "z-10 border-t bg-card/95 p-3 backdrop-blur",
          inPanel ? "sticky bottom-0 -mx-4" : "fixed inset-x-0 bottom-0 sm:static sm:border-0 sm:bg-transparent sm:p-0",
        )}
      >
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {items ? t("page.unsynced", { count: counts.unsynced }) : t("page.loading")}
          </p>
          <Button type="button" onClick={() => void syncNow()} disabled={!canSync} aria-busy={syncing}>
            {syncing ? t("actions.syncing") : t("actions.syncNow")}
          </Button>
        </div>
      </div>

      {!items || !engine ? (
        loadFailed ? null : (
          <p className="text-sm text-muted-foreground" role="status">
            {t("page.loading")}
          </p>
        )
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("page.empty")}</p>
      ) : (
        <>
          <Section title={t("sections.attention")} items={groups.attention} engine={engine} online={online} level={inPanel ? 3 : 2} />
          <Section title={t("sections.waiting")} items={groups.waiting} engine={engine} online={online} level={inPanel ? 3 : 2} />
          {groups.done.length > 0 ? (
            <details className="space-y-2">
              <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">
                {t("sections.done")} ({groups.done.length})
              </summary>
              <ItemList items={groups.done} engine={engine} online={online} />
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}

interface ListProps {
  items: QueueItem[];
  engine: SyncEngine;
  online: boolean;
}

function Section({ title, level, ...list }: ListProps & { title: string; level: 2 | 3 }) {
  if (list.items.length === 0) return null;
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section className="space-y-2">
      <Heading className="text-lg font-semibold">
        {title} ({list.items.length})
      </Heading>
      <ItemList {...list} />
    </section>
  );
}

function ItemList({ items, engine, online }: ListProps) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.id}>
          <QueueItemCard item={item} engine={engine} online={online} />
        </li>
      ))}
    </ul>
  );
}

function ReportLine({ report }: { report: SyncReport }) {
  const t = useTranslations("offline.report");
  if (report.offline) return <Alert tone="info" role="status">{t("offline")}</Alert>;
  if (report.busy) return <Alert tone="info" role="status">{t("busy")}</Alert>;
  const attention = report.failed + report.conflicts + report.stale;
  return (
    <Alert tone={attention > 0 || report.interrupted ? "info" : "success"} role="status">
      {t("result", { done: report.done })}
      {attention > 0 ? <> {t("attention", { count: attention })}</> : null}
      {report.interrupted ? <> {t("interrupted")}</> : null}
    </Alert>
  );
}
