"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { startOfflineDevice } from "@/modules/offline/senders";
import { loadCatalogSnapshot } from "./actions";
import { CATALOG_KEY_SUFFIX, clearOtherUsersOrders, loadCatalog, ORDERS_STORAGE_PREFIX, ordersStorageKeys, saveCatalog } from "./device-store";
import { CATALOG_MAX_AGE_MS, isSnapshotFresh, type CatalogSnapshot } from "./offline-logic";

/**
 * Browser glue for the order builder: the device start (senders, other users'
 * data wiped) and the catalogue snapshot used for offline search and
 * indicative prices. Client components only.
 */

const startedUsers = new Set<string>();

/** Once per user per page load: queue senders, other users' queues and order data wiped (shared devices). */
export function useOrdersDeviceStart(userId: string): void {
  useEffect(() => {
    startOfflineDevice(userId);
    if (startedUsers.has(userId)) return;
    startedUsers.add(userId);
    clearOtherUsersOrders(userId);
  }, [userId]);
}

// ---------------------------------------------------------------------------
// The saved snapshot as an external store (one parse per change, shared by every component and tab)
// ---------------------------------------------------------------------------

const snapshots = new Map<string, CatalogSnapshot | null>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

function storedSnapshot(userId: string): CatalogSnapshot | null {
  if (!snapshots.has(userId)) snapshots.set(userId, loadCatalog(userId));
  return snapshots.get(userId) ?? null;
}

function storeSnapshot(userId: string, snapshot: CatalogSnapshot): void {
  saveCatalog(userId, snapshot); // may fail (quota): the snapshot still serves this page
  snapshots.set(userId, snapshot);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    // Another tab refreshed (or signed out and cleared): read it again.
    if (event.key === null || (event.key.startsWith(ORDERS_STORAGE_PREFIX) && event.key.endsWith(CATALOG_KEY_SUFFIX))) {
      snapshots.clear();
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export interface CatalogState {
  /** null on the server, and until something was saved on this device. */
  snapshot: CatalogSnapshot | null;
  /** The last online refresh failed (the saved snapshot, if any, is still used). */
  refreshFailed: boolean;
}

/**
 * The sellable-variant list saved on this device for this user. Refreshed from
 * the server while online when older than 30 minutes: on open, when the
 * connection returns, and every 30 minutes.
 */
export function useCatalogSnapshot(userId: string, online: boolean): CatalogState {
  const snapshot = useSyncExternalStore(
    subscribe,
    useCallback(() => storedSnapshot(userId), [userId]),
    () => null,
  );
  const [refreshFailed, setRefreshFailed] = useState(false);

  useEffect(() => {
    if (!online) return;
    ordersStorageKeys(userId); // validates the id before any storage access
    let alive = true;
    const refresh = async (force: boolean) => {
      if (!force && isSnapshotFresh(storedSnapshot(userId), Date.now())) return;
      try {
        const res = await loadCatalogSnapshot();
        if (!alive) return;
        if (res.ok) storeSnapshot(userId, res.snapshot);
        setRefreshFailed(!res.ok);
      } catch {
        if (alive) setRefreshFailed(true);
      }
    };
    void refresh(false);
    const timer = window.setInterval(() => void refresh(true), CATALOG_MAX_AGE_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [userId, online]);

  return { snapshot, refreshFailed };
}
