import type { BuilderLine } from "./types";
import { MAX_LINES, MAX_QUANTITY } from "./logic";
import type { CachedVariant, CatalogSnapshot, DraftSlot, LocalDraft } from "./offline-logic";

/**
 * What this device keeps for the order builder, in localStorage, per user:
 *   honest.orders.v1:<userId>           builder copies (lines, customer, notes) by slot
 *   honest.orders.v1:<userId>:catalog   the last online sellable-variant list with list prices
 * Queued saves themselves live in the user's IndexedDB queue (src/lib/offline).
 *
 * Shared devices: sign-out calls clearOrdersDevice(userId); on start the
 * builder calls clearOtherUsersOrders(userId), so one rep's drafts and price
 * snapshot never stay behind for the next one. All reads are tolerant: a
 * malformed value is dropped, never trusted.
 */

export const ORDERS_STORAGE_PREFIX = "honest.orders.v1:";
export const CATALOG_KEY_SUFFIX = ":catalog";
/** Builder copies kept per user (oldest dropped first). */
export const MAX_LOCAL_DRAFTS = 20;
/** Sellable variants kept on the device for offline search. */
export const CATALOG_MAX_VARIANTS = 5000;

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ordersStorageKeys(userId: string): { drafts: string; catalog: string } {
  if (!USER_ID.test(userId)) throw new Error("orders device store: invalid user id");
  return { drafts: ORDERS_STORAGE_PREFIX + userId, catalog: ORDERS_STORAGE_PREFIX + userId + CATALOG_KEY_SUFFIX };
}

export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // storage disabled: nothing is kept
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 1000): string | null => (typeof v === "string" && v.length <= max ? v : null);
const uuid = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v : null);

function read(storage: KeyValueStorage | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function write(storage: KeyValueStorage | null, key: string, value: unknown): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // quota or disabled storage: the builder keeps working in memory
  }
}

// ---------------------------------------------------------------------------
// Builder copies
// ---------------------------------------------------------------------------

function parseLine(v: unknown): BuilderLine | null {
  if (!isObject(v)) return null;
  const variant = uuid(v.variant_id);
  const q = v.quantity;
  // Quantity 0 is an empty input the rep is still typing; it is kept as is.
  if (!variant || typeof q !== "number" || !Number.isInteger(q) || q < 0 || q > MAX_QUANTITY) return null;
  // Only ids, the quantity and display text survive: nothing else is ever restored.
  return { variant_id: variant, quantity: q, sku: str(v.sku, 200) ?? "", name: str(v.name, 500) ?? "" };
}

export function parseLocalDraft(v: unknown): LocalDraft | null {
  if (!isObject(v) || typeof v.slot !== "string") return null;
  const orderId = v.orderId == null ? null : uuid(v.orderId);
  if (v.orderId != null && orderId === null) return null;
  const lines = Array.isArray(v.lines) ? v.lines.slice(0, MAX_LINES).map(parseLine).filter((l): l is BuilderLine => l !== null) : [];
  const version = typeof v.serverVersion === "number" && Number.isInteger(v.serverVersion) && v.serverVersion >= 0 ? v.serverVersion : 0;
  return {
    slot: v.slot,
    orderId,
    serverVersion: version,
    customerId: uuid(v.customerId) ?? "",
    visitId: uuid(v.visitId),
    notes: str(v.notes) ?? "",
    lines,
    dirty: v.dirty === true,
    updatedAt: str(v.updatedAt, 40) ?? new Date(0).toISOString(),
  };
}

export function loadDrafts(userId: string, storage: KeyValueStorage | null = browserStorage()): Record<DraftSlot, LocalDraft> {
  const raw = read(storage, ordersStorageKeys(userId).drafts);
  const out: Record<DraftSlot, LocalDraft> = {};
  if (!isObject(raw)) return out;
  for (const value of Object.values(raw)) {
    const draft = parseLocalDraft(value);
    if (draft) out[draft.slot] = draft;
  }
  return out;
}

export function loadDraft(userId: string, slot: DraftSlot, storage: KeyValueStorage | null = browserStorage()): LocalDraft | null {
  return loadDrafts(userId, storage)[slot] ?? null;
}

export function saveLocalDraft(userId: string, draft: LocalDraft, storage: KeyValueStorage | null = browserStorage()): boolean {
  const all = { ...loadDrafts(userId, storage), [draft.slot]: draft };
  const kept = Object.values(all)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_LOCAL_DRAFTS);
  return write(storage, ordersStorageKeys(userId).drafts, Object.fromEntries(kept.map((d) => [d.slot, d])));
}

export function removeLocalDraft(userId: string, slot: DraftSlot, storage: KeyValueStorage | null = browserStorage()): void {
  const all = loadDrafts(userId, storage);
  if (!(slot in all)) return;
  delete all[slot];
  write(storage, ordersStorageKeys(userId).drafts, all);
}

// ---------------------------------------------------------------------------
// Catalogue snapshot
// ---------------------------------------------------------------------------

function parseVariant(v: unknown): CachedVariant | null {
  if (!isObject(v)) return null;
  const id = uuid(v.variant_id);
  const sku = str(v.sku, 200);
  const name = str(v.variant_name, 500);
  if (!id || sku === null || name === null) return null;
  const price = typeof v.price === "number" && Number.isFinite(v.price) && v.price >= 0 ? v.price : null;
  return {
    variant_id: id,
    sku,
    variant_name: name,
    uom: str(v.uom, 50) ?? "",
    product_code: str(v.product_code, 200) ?? "",
    product_name_en: str(v.product_name_en, 500) ?? "",
    product_name_ar: str(v.product_name_ar, 500),
    brand_name: str(v.brand_name, 200),
    price,
  };
}

export function parseCatalog(v: unknown): CatalogSnapshot | null {
  if (!isObject(v) || typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at)) || !Array.isArray(v.variants)) return null;
  return {
    at: v.at,
    variants: v.variants.slice(0, CATALOG_MAX_VARIANTS).map(parseVariant).filter((x): x is CachedVariant => x !== null),
    truncated: v.truncated === true,
  };
}

export function loadCatalog(userId: string, storage: KeyValueStorage | null = browserStorage()): CatalogSnapshot | null {
  return parseCatalog(read(storage, ordersStorageKeys(userId).catalog));
}

export function saveCatalog(userId: string, snapshot: CatalogSnapshot, storage: KeyValueStorage | null = browserStorage()): boolean {
  return write(storage, ordersStorageKeys(userId).catalog, snapshot);
}

// ---------------------------------------------------------------------------
// Shared devices
// ---------------------------------------------------------------------------

/** Sign-out: forgets this user's builder copies and catalogue snapshot on this device. */
export function clearOrdersDevice(userId: string, storage: KeyValueStorage | null = browserStorage()): void {
  if (!storage) return;
  const keys = ordersStorageKeys(userId);
  for (const key of [keys.drafts, keys.catalog]) {
    try {
      storage.removeItem(key);
    } catch {
      // nothing more to do
    }
  }
}

/** App start: removes every OTHER user's order data from this device. Returns how many keys were removed. */
export function clearOtherUsersOrders(userId: string, storage: KeyValueStorage | null = browserStorage()): number {
  if (!storage) return 0;
  const keep = ordersStorageKeys(userId);
  const doomed: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(ORDERS_STORAGE_PREFIX) && key !== keep.drafts && key !== keep.catalog) doomed.push(key);
    }
  } catch {
    return 0;
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
