"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getSyncEngine } from "@/lib/offline/client";
import type { SyncEngine } from "@/lib/offline/sync";
import type { JsonObject } from "@/lib/offline/types";
import type { GeoOutcome } from "@/modules/field/geo";
import { ensureSendersRegistered, startOfflineDevice } from "@/modules/offline/senders";
import { endShift, loadTrackingStatus, recordLocationPings, startShift } from "./actions";
import { requestWakeLock, startCollector, type Sample } from "./collector";
import { applyStatus, EMPTY_STATE, trackingStoreFor, type DeviceState } from "./device-store";
import {
  isCollecting,
  shiftGroup,
  shouldFlush,
  submitTrackingCommand,
  toPing,
  TRACKING_QUEUED_COMMANDS,
  type TrackingSubmit,
} from "./logic";
import type { EndShiftPayload, StartShiftPayload } from "./schemas";
import type { EndShiftResult, StartShiftResult, TrackingStatus } from "./types";

/**
 * Browser glue for work-hours tracking: the shared device state, the collector
 * (header, app-wide), and the Start / End my day commands (shift card). Client
 * components only. NEVER collects without an open shift: the collector runs only
 * while isCollecting(shift) and the page is visible.
 */

ensureSendersRegistered();

const online = () => typeof navigator === "undefined" || navigator.onLine !== false;

function engineFor(userId: string): SyncEngine | null {
  if (typeof window === "undefined") return null;
  startOfflineDevice(userId);
  try {
    return getSyncEngine(userId);
  } catch {
    return null;
  }
}

/** The device state for this user, live (the empty state on the server). */
export function useTrackingState(userId: string): DeviceState {
  const subscribe = useCallback((listener: () => void) => trackingStoreFor(userId).subscribe(listener), [userId]);
  return useSyncExternalStore(
    subscribe,
    () => trackingStoreFor(userId).get(),
    () => EMPTY_STATE,
  );
}

// One shared clock for the tracking UI (re-renders every 30 s; null on the server and before mount).
const clockListeners = new Set<() => void>();
let clockNow: number | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (!clockTimer) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const l of clockListeners) l();
    }, 30_000);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

/** Device time in ms, refreshed every 30 seconds (null during the server render). */
export function useClock(): number | null {
  return useSyncExternalStore(
    subscribeClock,
    () => clockNow,
    () => null,
  );
}

/** Merge a server status read into the device state. `fetchedAtMs` = device ms when the read started. */
export function applyServerStatus(userId: string, status: TrackingStatus, fetchedAtMs: number): void {
  trackingStoreFor(userId).update((s) => applyStatus(s, status, fetchedAtMs, Date.now()));
}

export async function refreshStatus(userId: string): Promise<void> {
  const started = Date.now();
  try {
    const result = await loadTrackingStatus();
    if (result.ok && result.data) applyServerStatus(userId, result.data, started);
  } catch {
    // offline: keep the device's view
  }
}

/**
 * Hand the buffered points to the offline queue as one batch item (idempotent by
 * point id), then sync. Synced batches are removed from the queue list so the sync
 * panel is not flooded; the time is kept as "last point sent".
 */
export async function flushPoints(userId: string, opts: { force?: boolean } = {}): Promise<void> {
  const store = trackingStoreFor(userId);
  const state = store.get();
  if (state.buffer.length === 0 || !state.shift) return;
  if (!opts.force && !shouldFlush(state.buffer, Date.now())) return;
  const engine = engineFor(userId);
  const batch = state.buffer.slice(0, 500);
  if (engine) {
    try {
      await engine.enqueue({
        command: TRACKING_QUEUED_COMMANDS.recordPings,
        id: crypto.randomUUID(),
        args: { pings: batch } as unknown as JsonObject,
        groupKey: shiftGroup(state.shift.ref),
        summary: null,
      });
    } catch {
      return; // storage failed: the points stay buffered for the next try
    }
    const sent = new Set(batch.map((p) => p.id));
    store.update((s) => ({ ...s, buffer: s.buffer.filter((p) => !sent.has(p.id)) }));
    if (online()) await syncAndPrune(userId, engine);
    return;
  }
  // No offline storage on this device: send directly; keep the points if it fails.
  try {
    const result = await recordLocationPings({ pings: batch });
    if (result.ok) {
      const sent = new Set(batch.map((p) => p.id));
      store.update((s) => ({ ...s, buffer: s.buffer.filter((p) => !sent.has(p.id)), lastSentMs: Date.now() }));
    }
  } catch {
    // offline
  }
}

async function syncAndPrune(userId: string, engine: SyncEngine): Promise<void> {
  try {
    await engine.sync();
    const done = (await engine.list()).filter((i) => i.command === TRACKING_QUEUED_COMMANDS.recordPings && i.status === "done");
    if (done.length) {
      const last = Math.max(...done.map((i) => Date.parse(i.updatedAt) || 0));
      trackingStoreFor(userId).update((s) => ({ ...s, lastSentMs: Math.max(s.lastSentMs ?? 0, last) }));
      for (const item of done) await engine.discard(item.id);
    }
  } catch {
    // the next run retries
  }
}

function addSample(userId: string, sample: Sample): void {
  const store = trackingStoreFor(userId);
  store.update((s) => {
    // Never keep a point without an open shift, or past the shift's maximum length.
    if (!isCollecting(s.shift, Date.now())) return s;
    const ping = toPing({ id: crypto.randomUUID(), lat: sample.lat, lng: sample.lng, accuracy: sample.accuracy, timestampMs: sample.timestampMs });
    return { ...s, buffer: [...s.buffer, ping].slice(-500), lastSampleMs: Date.now() };
  });
  void flushPoints(userId);
}

/**
 * The app-wide collector (mounted once, in the header). Runs while a shift is open
 * and the page is visible; holds a screen wake lock where available; flushes the
 * buffer when the page is hidden; re-reads the server status on start and when
 * the page becomes visible again.
 */
export function useTrackingCollector(userId: string, enabled: boolean): DeviceState {
  const state = useTrackingState(userId);
  const now = useClock();
  const collecting = enabled && now !== null && isCollecting(state.shift, now);
  const intervalMs = Math.max(30, state.intervalS) * 1000;

  useEffect(() => {
    if (!enabled) return;
    void refreshStatus(userId);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshStatus(userId);
      else void flushPoints(userId, { force: true });
    };
    const onHide = () => void flushPoints(userId, { force: true });
    const onOnline = () => void flushPoints(userId, { force: true });
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("online", onOnline);
    };
  }, [enabled, userId]);

  useEffect(() => {
    if (!collecting) return;
    let stopCollector: (() => void) | null = null;
    let releaseLock: (() => void) | null = null;
    let alive = true;
    const store = trackingStoreFor(userId);

    const run = () => {
      if (stopCollector || document.visibilityState !== "visible") return;
      stopCollector = startCollector({
        geolocation: navigator.geolocation,
        isSecureContext: window.isSecureContext,
        intervalMs,
        now: Date.now,
        lastSampleMs: () => store.get().lastSampleMs,
        onSample: (sample) => addSample(userId, sample),
        onProblem: (problem) => {
          if (store.get().problem !== problem) store.update((s) => ({ ...s, problem }));
        },
      });
      void requestWakeLock().then((release) => {
        if (alive) releaseLock = release;
        else release?.();
      });
    };
    const pause = () => {
      stopCollector?.();
      stopCollector = null;
      releaseLock?.();
      releaseLock = null;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? run() : pause());
    const flushTimer = window.setInterval(() => void flushPoints(userId), 60_000);

    run();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(flushTimer);
      pause();
      void flushPoints(userId, { force: true });
    };
  }, [collecting, intervalMs, userId]);

  return state;
}

function fixFields(geo: GeoOutcome | null) {
  return geo?.ok ? { lat: geo.lat, lng: geo.lng, accuracy_m: geo.accuracyM } : { lat: null, lng: null, accuracy_m: null };
}

/** "Start my day": the ref, fix and device time are fixed before the first send (replay-safe). */
export async function startDay(userId: string, geo: GeoOutcome | null, summary: string): Promise<TrackingSubmit<StartShiftResult>> {
  const store = trackingStoreFor(userId);
  const ref = crypto.randomUUID();
  const capturedAt = geo?.ok ? geo.capturedAt : new Date().toISOString();
  const payload: StartShiftPayload = { client_ref: ref, ...fixFields(geo), captured_at: capturedAt };
  const outcome = await submitTrackingCommand<StartShiftResult>(
    { command: TRACKING_QUEUED_COMMANDS.startShift, id: ref, args: payload as unknown as JsonObject, groupKey: shiftGroup(ref), summary },
    { online: online(), queue: engineFor(userId), send: () => startShift(payload) },
  );
  const hours = store.get().maxShiftHours;
  if (outcome.kind === "sent") {
    store.update((s) => ({
      ...s,
      shift: {
        ref,
        startedAt: outcome.data.window_start,
        maxEndAt: outcome.data.max_end_at,
        confirmed: true,
        confirmedAtMs: Date.now(),
        serverId: outcome.data.shift_id,
        overdue: false,
      },
      buffer: [],
      lastSampleMs: null,
      lastEnded: null,
      startFailed: false,
    }));
  } else if (outcome.kind === "queued") {
    store.update((s) => ({
      ...s,
      shift: {
        ref,
        startedAt: capturedAt,
        maxEndAt: new Date(Date.parse(capturedAt) + hours * 3_600_000).toISOString(),
        confirmed: false,
        confirmedAtMs: null,
        serverId: null,
        overdue: false,
      },
      buffer: [],
      lastSampleMs: null,
      lastEnded: null,
      startFailed: false,
    }));
  }
  return outcome;
}

/** "End my day": hands the remaining points to the queue first (same shift group, so they apply before the end). */
export async function endDay(userId: string, geo: GeoOutcome | null, summary: string): Promise<TrackingSubmit<EndShiftResult>> {
  const store = trackingStoreFor(userId);
  const shift = store.get().shift;
  await flushPoints(userId, { force: true });
  const ref = crypto.randomUUID();
  const payload: EndShiftPayload = {
    client_ref: ref,
    shift_ref: shift?.ref ?? null,
    ...fixFields(geo),
    captured_at: geo?.ok ? geo.capturedAt : new Date().toISOString(),
  };
  const outcome = await submitTrackingCommand<EndShiftResult>(
    { command: TRACKING_QUEUED_COMMANDS.endShift, id: ref, args: payload as unknown as JsonObject, groupKey: shift ? shiftGroup(shift.ref) : null, summary },
    { online: online(), queue: engineFor(userId), send: () => endShift(payload) },
  );
  // Ended (now or once synced), or the server has no open shift any more: stop collecting either way.
  if (outcome.kind !== "error" || outcome.code === "NO_OPEN_SHIFT" || outcome.code === "INVALID_STATE") {
    store.update((s) => ({ ...s, shift: null, buffer: [], lastEnded: shift ? { ref: shift.ref, atMs: Date.now() } : s.lastEnded }));
  }
  return outcome;
}

/** Forget the device's shift: its queued start failed for good (e.g. the notice is missing). */
export function forgetFailedStart(userId: string, ref: string): void {
  trackingStoreFor(userId).update((s) => (s.shift?.ref === ref ? { ...s, shift: null, buffer: [], startFailed: true } : s));
}

export function dismissStartFailed(userId: string): void {
  trackingStoreFor(userId).update((s) => (s.startFailed ? { ...s, startFailed: false } : s));
}
