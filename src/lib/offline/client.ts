import { clearForUser as deleteUserQueue, createIdbStore, createMemoryStore, createQueue } from "./queue";
import { createSyncEngine, type SyncEngine } from "./sync";
import type { QueueStore } from "./types";

/**
 * Browser wiring for the offline queue: one engine per signed-in user, backed by
 * that user's IndexedDB, synced on app start, on the `online` event, when the tab
 * becomes visible again, every minute while items wait, and on "Sync now".
 * Tabs share changes over a BroadcastChannel and take turns with a Web Lock, so
 * two tabs never send the same queue at once (the server would dedupe anyway).
 * Import this only from client components.
 */

interface Entry {
  engine: SyncEngine;
  store: QueueStore;
  channel: BroadcastChannel | null;
  autoSyncUsers: number;
  stopAutoSync: (() => void) | null;
}

const entries = new Map<string, Entry>();

const channelName = (userId: string) => `honest-offline:${userId}`;

function openStore(userId: string): QueueStore {
  try {
    return createIdbStore(userId);
  } catch {
    // No IndexedDB (very old browser, some private modes): keep working online, nothing survives a reload.
    return createMemoryStore();
  }
}

function lockFor(userId: string) {
  return async <T>(fn: () => Promise<T>): Promise<T | null> => {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks) return fn();
    return locks.request(`honest-offline-sync:${userId}`, { ifAvailable: true }, async (lock) => (lock ? fn() : null));
  };
}

/** The sync engine for this user on this device (created on first use). */
export function getSyncEngine(userId: string): SyncEngine {
  if (typeof window === "undefined") throw new Error("offline queue: browser only");
  const existing = entries.get(userId);
  if (existing) return existing.engine;

  const store = openStore(userId);
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(channelName(userId));
  const remoteListeners = new Set<() => void>();

  const engine = createSyncEngine({
    queue: createQueue(store, userId),
    isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
    withLock: lockFor(userId),
    onChange: () => channel?.postMessage("changed"),
  });

  if (channel) {
    channel.onmessage = (event: MessageEvent) => {
      if (event.data === "cleared") return dispose(userId);
      for (const listener of remoteListeners) listener();
    };
  }

  // Listeners hear local changes and changes made by other tabs.
  const subscribe = engine.subscribe;
  engine.subscribe = (listener) => {
    remoteListeners.add(listener);
    const off = subscribe(listener);
    return () => {
      remoteListeners.delete(listener);
      off();
    };
  };

  entries.set(userId, { engine, store, channel, autoSyncUsers: 0, stopAutoSync: null });
  return engine;
}

function dispose(userId: string) {
  const entry = entries.get(userId);
  if (!entry) return;
  entry.stopAutoSync?.();
  entry.store.close();
  entry.channel?.close();
  entries.delete(userId);
}

/**
 * Starts automatic syncing for this user. Reference counted: safe to call from
 * several mounted components. Returns the stop function (call it on unmount).
 */
export function startAutoSync(userId: string, intervalMs = 60_000): () => void {
  const engine = getSyncEngine(userId);
  const entry = entries.get(userId) as Entry;
  entry.autoSyncUsers++;

  if (!entry.stopAutoSync && typeof window !== "undefined") {
    const run = () => {
      if (navigator.onLine !== false) void engine.sync().catch(() => undefined);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    window.addEventListener("online", run);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(run, intervalMs);
    run(); // app start
    entry.stopAutoSync = () => {
      window.removeEventListener("online", run);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
      entry.stopAutoSync = null;
    };
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    entry.autoSyncUsers--;
    if (entry.autoSyncUsers <= 0) entry.stopAutoSync?.();
  };
}

/** Items not yet confirmed by the server. Sign-out should warn when this is > 0. */
export async function countUnsynced(userId: string): Promise<number> {
  const items = await getSyncEngine(userId).list();
  return items.filter((i) => i.status !== "done").length;
}

/**
 * Sign-out: forgets this user's queue on this device (unsynced items are lost),
 * in this tab and in every other open tab.
 */
export async function clearForUser(userId: string): Promise<void> {
  const own = entries.get(userId)?.channel;
  const channel = own ?? (typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(channelName(userId)));
  channel?.postMessage("cleared");
  if (!own) channel?.close();
  dispose(userId);
  await deleteUserQueue(userId);
}
