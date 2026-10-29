"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getSyncEngine, startAutoSync } from "@/lib/offline/client";
import type { SyncEngine, SyncReport } from "@/lib/offline/sync";
import type { QueueItem } from "@/lib/offline/types";

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/** navigator.onLine as React state (true during server rendering). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

export interface OfflineQueueState {
  /** null during server rendering (the queue lives only in the browser). */
  engine: SyncEngine | null;
  /** null until the first read from IndexedDB. */
  items: QueueItem[] | null;
  /** The device could not open its offline storage. */
  loadFailed: boolean;
  syncing: boolean;
  online: boolean;
  /** Survives a reload (IndexedDB) or not (in-memory fallback). */
  persistent: boolean;
  lastReport: SyncReport | null;
  syncNow: () => Promise<SyncReport | null>;
}

/**
 * Live view of the signed-in user's offline queue. `autoSync` also starts the
 * background triggers (app start, `online`, tab visible, every minute); the
 * header indicator passes it so every page syncs.
 */
export function useOfflineQueue(userId: string, { autoSync = false }: { autoSync?: boolean } = {}): OfflineQueueState {
  // Never on the server: the engine opens IndexedDB and a BroadcastChannel.
  const engine = useMemo(() => (typeof window === "undefined" ? null : getSyncEngine(userId)), [userId]);
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [persistent, setPersistent] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastReport, setLastReport] = useState<SyncReport | null>(null);
  const online = useOnline();

  useEffect(() => {
    if (!engine) return;
    let alive = true;
    const load = () => {
      engine
        .list()
        .then((next) => {
          if (!alive) return;
          setItems(next);
          setLoadFailed(false);
          setSyncing(engine.isSyncing());
          setPersistent(engine.queue.persistent);
        })
        .catch(() => {
          if (alive) setLoadFailed(true);
        });
    };
    load();
    const off = engine.subscribe(load);
    return () => {
      alive = false;
      off();
    };
  }, [engine]);

  useEffect(() => (autoSync ? startAutoSync(userId) : undefined), [autoSync, userId]);

  const syncNow = async () => {
    if (!engine) return null;
    try {
      const report = await engine.sync();
      setLastReport(report);
      return report;
    } catch {
      setLoadFailed(true);
      return null;
    }
  };

  return { engine, items, loadFailed, syncing, online, persistent, lastReport, syncNow };
}
