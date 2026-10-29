"use client";

import { useCallback, useSyncExternalStore } from "react";
import { getSyncEngine } from "@/lib/offline/client";
import type { SyncEngine } from "@/lib/offline/sync";
import type { QueueItem } from "@/lib/offline/types";
import { ensureSendersRegistered, startOfflineDevice } from "@/modules/offline/senders";
import { submitDeviceCommand, type DeviceCommand, type SubmitOutcome } from "./logic";
import type { DeviceResult } from "./types";

/**
 * Browser glue between the field screens and the offline queue: send a field
 * command now or save it on the device (logic.ts submitDeviceCommand), and
 * watch saved commands until the server confirms them. Client components only.
 */

ensureSendersRegistered();

function engineFor(userId: string): SyncEngine | null {
  if (typeof window === "undefined") return null;
  startOfflineDevice(userId); // senders + wipe other users' queues (once)
  try {
    return getSyncEngine(userId);
  } catch {
    return null; // no usable offline storage: online-only
  }
}

const isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

/** Returns `submit(cmd, send)`: the direct call when possible, the queue when offline or on a safe-to-repeat failure. */
export function useDeviceSubmit(userId: string) {
  return useCallback(
    async <T>(cmd: DeviceCommand, send: () => Promise<DeviceResult<T>>): Promise<SubmitOutcome<T>> => {
      ensureSendersRegistered();
      const engine = engineFor(userId);
      const outcome = await submitDeviceCommand(cmd, { online: isOnline(), queue: engine, send });
      // Queued while the device reports a connection (lost answer, or behind an earlier step): try now.
      if (outcome.kind === "queued" && engine && isOnline()) void engine.sync().catch(() => undefined);
      return outcome;
    },
    [userId],
  );
}

// ---------------------------------------------------------------------------
// One shared, live list of this user's queue for every field component on the page
// ---------------------------------------------------------------------------

interface Watch {
  items: QueueItem[] | null;
  listeners: Set<() => void>;
  stop: (() => void) | null;
}

const watches = new Map<string, Watch>();

function watchFor(userId: string): Watch {
  let watch = watches.get(userId);
  if (!watch) {
    watch = { items: null, listeners: new Set(), stop: null };
    watches.set(userId, watch);
  }
  return watch;
}

function subscribe(userId: string, listener: () => void): () => void {
  const watch = watchFor(userId);
  watch.listeners.add(listener);
  if (!watch.stop) {
    const engine = engineFor(userId);
    if (engine) {
      let alive = true;
      const load = () => {
        engine
          .list()
          .then((items) => {
            if (!alive) return;
            watch.items = items;
            for (const l of watch.listeners) l();
          })
          .catch(() => undefined);
      };
      const off = engine.subscribe(load);
      load();
      watch.stop = () => {
        alive = false;
        off();
        watch.stop = null;
      };
    }
  }
  return () => {
    watch.listeners.delete(listener);
    if (watch.listeners.size === 0) watch.stop?.();
  };
}

/** This user's queue on this device, live (null on the server and before the first read). */
export function useQueueItems(userId: string): QueueItem[] | null {
  const sub = useCallback((listener: () => void) => subscribe(userId, listener), [userId]);
  return useSyncExternalStore(
    sub,
    () => watchFor(userId).items,
    () => null,
  );
}

/** One saved command by its queue item id, live. */
export function useQueuedItem(userId: string, id: string | null | undefined): QueueItem | undefined {
  const items = useQueueItems(userId);
  return id ? items?.find((item) => item.id === id) : undefined;
}
