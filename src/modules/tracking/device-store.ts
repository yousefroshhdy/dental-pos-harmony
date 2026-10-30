import { reconcileShift, type EndedShift, type LocalShift } from "./logic";
import type { PingInput, TrackingStatus } from "./types";

/**
 * What this device remembers for the signed-in rep's working day, in
 * localStorage (one key per user): the open shift, the few points not yet
 * handed to the offline queue, and the sampling clock. Shared by the header
 * collector and the shift card on the same page, and across tabs (storage
 * events). Points move to the IndexedDB queue in small batches (use-tracking.ts).
 *
 * Shared devices: on start, every OTHER user's tracking key is deleted, so one
 * rep's points never stay behind for the next one (like clearOtherUsers).
 */

export const STORAGE_PREFIX = "honest.tracking.v1:";

export type CollectorProblem = "denied" | "unavailable" | "timeout" | "unsupported" | "insecure";

export interface DeviceState {
  shift: LocalShift | null;
  /** Points kept, not yet in the upload queue (oldest first). */
  buffer: PingInput[];
  /** Device ms of the last kept point. */
  lastSampleMs: number | null;
  /** Device ms when a batch was last confirmed by the server. */
  lastSentMs: number | null;
  /** The shift this device ended last (its end may still wait to sync). */
  lastEnded: EndedShift | null;
  /** Seconds between points (server setting). */
  intervalS: number;
  maxShiftHours: number;
  /** Why the collector cannot read the location right now. */
  problem: CollectorProblem | null;
  /** A start saved offline was refused by the server (shown once on the shift card). */
  startFailed: boolean;
}

export const EMPTY_STATE: DeviceState = {
  shift: null,
  buffer: [],
  lastSampleMs: null,
  lastSentMs: null,
  lastEnded: null,
  intervalS: 300,
  maxShiftHours: 10,
  problem: null,
  startFailed: false,
};

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseShift(v: unknown): LocalShift | null {
  if (!isObject(v) || typeof v.ref !== "string" || typeof v.startedAt !== "string" || typeof v.maxEndAt !== "string") return null;
  return {
    ref: v.ref,
    startedAt: v.startedAt,
    maxEndAt: v.maxEndAt,
    confirmed: v.confirmed === true,
    confirmedAtMs: num(v.confirmedAtMs),
    serverId: typeof v.serverId === "string" ? v.serverId : null,
    overdue: v.overdue === true,
  };
}

function parsePing(v: unknown): PingInput | null {
  if (!isObject(v) || typeof v.id !== "string" || typeof v.captured_at !== "string") return null;
  const lat = num(v.lat);
  const lng = num(v.lng);
  if (lat === null || lng === null) return null;
  return { id: v.id, lat, lng, accuracy_m: num(v.accuracy_m), captured_at: v.captured_at, source: "pwa" };
}

/** Tolerant parse: anything malformed falls back to the empty state's value. */
export function parseState(raw: string | null): DeviceState {
  if (!raw) return { ...EMPTY_STATE };
  try {
    const v = JSON.parse(raw) as unknown;
    if (!isObject(v)) return { ...EMPTY_STATE };
    const ended = isObject(v.lastEnded) && typeof v.lastEnded.ref === "string" && num(v.lastEnded.atMs) !== null
      ? { ref: v.lastEnded.ref, atMs: v.lastEnded.atMs as number }
      : null;
    return {
      shift: parseShift(v.shift),
      buffer: Array.isArray(v.buffer) ? v.buffer.map(parsePing).filter((p): p is PingInput => p !== null) : [],
      lastSampleMs: num(v.lastSampleMs),
      lastSentMs: num(v.lastSentMs),
      lastEnded: ended,
      intervalS: num(v.intervalS) ?? EMPTY_STATE.intervalS,
      maxShiftHours: num(v.maxShiftHours) ?? EMPTY_STATE.maxShiftHours,
      problem: null, // transient, never restored
      startFailed: v.startFailed === true,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

/** Server status → the device state (shift reconciled, settings refreshed). */
export function applyStatus(state: DeviceState, status: TrackingStatus, fetchedAtMs: number, nowMs: number): DeviceState {
  const shift = reconcileShift(state.shift, status.open_shift, { fetchedAtMs, nowMs, lastEnded: state.lastEnded });
  return {
    ...state,
    shift,
    // The server no longer knows the ended shift as open: forget the marker.
    lastEnded: state.lastEnded && status.open_shift?.client_ref !== state.lastEnded.ref ? null : state.lastEnded,
    intervalS: Number(status.settings?.sample_interval_s) || state.intervalS,
    maxShiftHours: Number(status.settings?.max_shift_hours) || state.maxShiftHours,
  };
}

export interface TrackingStore {
  get(): DeviceState;
  update(fn: (state: DeviceState) => DeviceState): DeviceState;
  subscribe(listener: () => void): () => void;
}

function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // storage disabled: the state lasts for this page only
  }
}

/** Removes every other user's tracking state from this device. Returns how many keys were removed. */
export function clearOtherUsers(userId: string, storage: KeyValueStorage | null = browserStorage()): number {
  if (!storage) return 0;
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && key.startsWith(STORAGE_PREFIX) && key !== STORAGE_PREFIX + userId) doomed.push(key);
  }
  for (const key of doomed) {
    try {
      storage.removeItem(key);
    } catch {
      // nothing more to do
    }
  }
  return doomed.length;
}

export function createTrackingStore(userId: string, storage: KeyValueStorage | null = browserStorage()): TrackingStore {
  const key = STORAGE_PREFIX + userId;
  const listeners = new Set<() => void>();
  let state = parseState(storage?.getItem(key) ?? null);

  const emit = () => {
    for (const l of listeners) l();
  };

  if (typeof window !== "undefined" && storage) {
    window.addEventListener("storage", (event: StorageEvent) => {
      if (event.key !== key) return;
      state = { ...parseState(event.newValue), problem: state.problem };
      emit();
    });
  }

  return {
    get: () => state,
    update(fn) {
      state = fn(state);
      try {
        const { problem: _transient, ...persisted } = state;
        void _transient;
        storage?.setItem(key, JSON.stringify(persisted));
      } catch {
        // quota or policy: keep the in-memory state
      }
      emit();
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const stores = new Map<string, TrackingStore>();

/** The page-wide store for this user (browser only; first use also wipes other users' state). */
export function trackingStoreFor(userId: string): TrackingStore {
  let store = stores.get(userId);
  if (!store) {
    clearOtherUsers(userId);
    store = createTrackingStore(userId);
    stores.set(userId, store);
  }
  return store;
}
