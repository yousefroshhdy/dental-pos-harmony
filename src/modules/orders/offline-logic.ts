import type { Result } from "@/lib/errors";
import type { EnqueueInput } from "@/lib/offline/queue";
import { toSendResult } from "@/lib/offline/result";
import type { Json, JsonObject, QueueItem, SendResult } from "@/lib/offline/types";
import { nameBasedId } from "@/modules/field/logic";
import { MAX_LINES, MAX_QUANTITY, orderErrorCode, sanitizeSearch, type OrderErrorCode } from "./logic";
import type { BuilderLine, SellableVariant } from "./types";

/**
 * Offline order drafts (docs/ARCHITECTURE.md §6, A-05: "Order: draft only;
 * submit requires online"). Pure rules, shared by the builder, the queue sender
 * and the unit tests:
 *
 * - "Save draft" sends api.save_order_draft now, or saves it in the device
 *   queue (offline, lost answer, or behind an earlier save of the same draft).
 *   The command is replay-safe under (order id, base version) (migration
 *   20261103000300), so the queue item id is derived from exactly that key.
 * - The payload holds ids, whole quantities and text. Never a price, discount,
 *   tax or total (CLAUDE.md rule 7): buildDraftPayload copies only allowed keys.
 * - Submitting is online-only; nothing here queues it.
 * - The builder shows indicative list prices from the last online catalogue
 *   snapshot; the server sets the real price.
 */

export const ORDER_QUEUED_COMMANDS = { saveDraft: "orders.save_order_draft" } as const;

/** What the device sends for one draft save (the server action re-validates it: schemas.ts draftPayloadSchema). */
export interface DraftPayload {
  /** Generated on the device for a new draft; the creating call and its replays share it. */
  order_id: string;
  customer_id: string;
  lines: { variant_id: string; quantity: number }[];
  notes: string | null;
  visit_id: string | null;
  /** The draft's server version this save is based on; null for the creating call. */
  version: number | null;
}

/** What api.save_order_draft answers, reduced to what the device keeps (no prices: the order page shows them). */
export interface DraftSaveAnswer {
  order_id: string;
  version: number;
  status: string;
  created: boolean;
  replayed: boolean;
}

/** 0 = the creating call (p_version null), else the version the save is based on. */
export const baseVersionOf = (payload: Pick<DraftPayload, "version">) => payload.version ?? 0;

/** Queue item id of one draft save: the idempotency key of api.save_order_draft, as a uuid. */
export function draftQueueId(orderId: string, baseVersion: number): string {
  return nameBasedId(`${ORDER_QUEUED_COMMANDS.saveDraft}:${orderId}:${baseVersion}`);
}

/** Saves of one draft apply strictly in order. */
export const draftGroupKey = (orderId: string) => `order:${orderId}`;

/**
 * The payload for one save. Copies ONLY the allowed keys, whatever else the
 * builder lines carry, so a display price can never reach the server.
 */
export function buildDraftPayload(input: {
  orderId: string;
  customerId: string;
  lines: readonly Pick<BuilderLine, "variant_id" | "quantity">[];
  notes: string;
  visitId: string | null;
  baseVersion: number;
}): DraftPayload {
  const notes = input.notes.trim();
  return {
    order_id: input.orderId,
    customer_id: input.customerId,
    lines: input.lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity })),
    notes: notes === "" ? null : notes,
    visit_id: input.visitId,
    version: input.baseVersion > 0 ? input.baseVersion : null,
  };
}

/** The builder may save: a customer, 1..MAX_LINES lines, every quantity a whole number in range. */
export function canSaveDraft(customerId: string, lines: readonly Pick<BuilderLine, "quantity">[]): boolean {
  return (
    customerId !== "" &&
    lines.length > 0 &&
    lines.length <= MAX_LINES &&
    lines.every((l) => Number.isInteger(l.quantity) && l.quantity >= 1 && l.quantity <= MAX_QUANTITY)
  );
}

// ---------------------------------------------------------------------------
// Queue state of one draft
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Queued saves of this draft, in queue order. */
export function draftItems(items: readonly QueueItem[] | null | undefined, orderId: string | null): QueueItem[] {
  if (!items || !orderId) return [];
  return items.filter((i) => i.command === ORDER_QUEUED_COMMANDS.saveDraft && i.args.order_id === orderId);
}

const versionArg = (item: QueueItem) => (typeof item.args.version === "number" ? item.args.version : 0);

/** The highest draft version the server confirmed for these saves (0 if none). */
export function syncedVersion(items: readonly QueueItem[]): number {
  let v = 0;
  for (const item of items) {
    if (item.status === "done" && isObject(item.result) && typeof item.result.version === "number") v = Math.max(v, item.result.version);
  }
  return v;
}

/**
 * The version the next save must be based on: the newest version known on the
 * server, or the version a save still waiting in the queue will produce.
 * Failed and conflicting saves did not apply, so they do not count.
 */
export function nextBaseVersion(items: readonly QueueItem[], knownServerVersion: number): number {
  let base = Math.max(knownServerVersion, syncedVersion(items));
  for (const item of items) {
    if (item.status === "pending" || item.status === "syncing") base = Math.max(base, versionArg(item) + 1);
  }
  return base;
}

export type DraftQueueState = "none" | "waiting" | "synced" | "attention";

/** What the builder shows about this draft's queued saves. */
export function draftQueueState(items: readonly QueueItem[]): DraftQueueState {
  if (items.length === 0) return "none";
  if (items.some((i) => i.status === "failed" || i.status === "conflict" || (i.flag === "stale" && !i.staleAcknowledged && i.status === "pending"))) {
    return "attention";
  }
  if (items.some((i) => i.status !== "done")) return "waiting";
  return "synced";
}

// ---------------------------------------------------------------------------
// Send now or queue
// ---------------------------------------------------------------------------

/** The part of the sync engine the decision needs (a SyncEngine satisfies it). */
export interface DraftQueue {
  list(): Promise<QueueItem[]>;
  enqueue(input: EnqueueInput): Promise<QueueItem>;
}

export type DraftQueueReason = "offline" | "network" | "ordered" | "already_saved";

export type DraftSubmitOutcome =
  | { kind: "sent"; data: DraftSaveAnswer }
  | { kind: "queued"; item: QueueItem; reason: DraftQueueReason }
  | { kind: "error"; code: OrderErrorCode; requestId?: string; conflict: boolean };

/**
 * Save a draft now, or in the device queue.
 *
 * - This exact save (same order id and base version) is already on the
 *   device: never sent again from here; a synced one answers its saved result.
 * - An unresolved earlier save of the same draft: queued behind it (order).
 * - Offline: queued.
 * - Online: sent directly. A failure that is safe to repeat (the request threw,
 *   or the answer is retryable / of unknown outcome) is queued: the server
 *   answers a replay as `replayed`. A business error or a version conflict goes
 *   back to the builder and is NEVER queued.
 * - No usable queue (no IndexedDB): direct send only.
 */
export async function submitOrderDraft(
  payload: DraftPayload,
  deps: { online: boolean; queue: DraftQueue | null; send: (payload: DraftPayload) => Promise<SendResult>; summary?: string | null },
): Promise<DraftSubmitOutcome> {
  const id = draftQueueId(payload.order_id, baseVersionOf(payload));
  const groupKey = draftGroupKey(payload.order_id);
  let queue = deps.queue;
  let items: QueueItem[] = [];
  if (queue) {
    try {
      items = await queue.list();
    } catch {
      queue = null; // offline storage is broken on this device: online-only
    }
  }

  const unavailable = (): DraftSubmitOutcome => ({ kind: "error", code: "UNAVAILABLE", conflict: false });
  const save = async (reason: DraftQueueReason): Promise<DraftSubmitOutcome> => {
    if (!queue) return unavailable();
    try {
      const item = await queue.enqueue({
        command: ORDER_QUEUED_COMMANDS.saveDraft,
        id,
        args: payload as unknown as JsonObject,
        groupKey,
        summary: deps.summary ?? null,
      });
      return { kind: "queued", item, reason };
    } catch {
      return unavailable();
    }
  };

  const existing = items.find((i) => i.id === id);
  if (existing) {
    const answer = asDraftSaveAnswer(existing.result);
    if (existing.status === "done" && answer) return { kind: "sent", data: answer };
    return { kind: "queued", item: existing, reason: "already_saved" };
  }
  if (items.some((i) => i.groupKey === groupKey && i.status !== "done")) return save("ordered");
  if (!deps.online && queue) return save("offline");

  let result: SendResult;
  try {
    result = await deps.send(payload);
  } catch {
    // A server action rejects when the request got no answer (offline, connection dropped).
    return save("network");
  }
  if (result.ok) {
    const answer = asDraftSaveAnswer(result.data);
    return answer ? { kind: "sent", data: answer } : { kind: "error", code: "UNKNOWN", conflict: false };
  }
  const { error } = result;
  if (!error.conflict && (error.retryable || error.ambiguous)) return save("network");
  return {
    kind: "error",
    code: orderErrorCode({ code: error.code, messageKey: error.messageKey, detail: "" }),
    ...(error.requestId ? { requestId: error.requestId } : {}),
    conflict: Boolean(error.conflict),
  };
}

/** A stored or returned answer, if it has the shape of DraftSaveAnswer. */
export function asDraftSaveAnswer(value: Json | null | undefined): DraftSaveAnswer | null {
  if (!isObject(value) || typeof value.order_id !== "string" || typeof value.version !== "number") return null;
  return {
    order_id: value.order_id,
    version: value.version,
    status: typeof value.status === "string" ? value.status : "draft",
    created: value.created === true,
    replayed: value.replayed === true,
  };
}

/**
 * api.save_order_draft's result → what the sender returns (server side). The
 * answer keeps no prices. A discontinued variant ('NOT_FOUND: … not sellable')
 * keeps its own code, since only the code reaches the device.
 */
export function toDraftSendResult(result: Result<unknown>): SendResult {
  if (result.ok) {
    const data = isObject(result.data) ? result.data : {};
    const answer: DraftSaveAnswer = {
      order_id: String(data.order_id ?? ""),
      version: typeof data.version === "number" ? data.version : Number(data.version ?? 0),
      status: typeof data.status === "string" ? data.status : "draft",
      created: data.created === true,
      replayed: data.replayed === true,
    };
    return { ok: true, data: answer as unknown as Json };
  }
  const sent = toSendResult(result);
  if (sent.ok) return sent;
  const code = orderErrorCode(result.error) === "VARIANT_NOT_SELLABLE" ? "VARIANT_NOT_SELLABLE" : sent.error.code;
  return { ok: false, error: { ...sent.error, code } };
}

// ---------------------------------------------------------------------------
// Catalogue snapshot (offline search and indicative prices)
// ---------------------------------------------------------------------------

/** One sellable variant as cached on the device, with the DEFAULT list's single-unit price (null if unknown). */
export interface CachedVariant extends SellableVariant {
  price: number | null;
}

export interface CatalogSnapshot {
  /** ISO time the server answered. */
  at: string;
  variants: CachedVariant[];
  /** The server had more sellable variants than the device keeps. */
  truncated: boolean;
}

/** Refreshed on open and every 30 minutes online (docs/ARCHITECTURE.md §6). */
export const CATALOG_MAX_AGE_MS = 30 * 60 * 1000;

export function isSnapshotFresh(snapshot: Pick<CatalogSnapshot, "at"> | null, now: number, maxAgeMs = CATALOG_MAX_AGE_MS): boolean {
  if (!snapshot) return false;
  const at = Date.parse(snapshot.at);
  return Number.isFinite(at) && now - at < maxAgeMs && at <= now + 60_000;
}

const fold = (s: string | null | undefined) => (s ?? "").normalize("NFKC").toLowerCase();

/** Offline catalogue search: same fields and minimum length as the server search, every word must match. */
export function searchCatalog(snapshot: CatalogSnapshot | null, raw: string, limit = 20): CachedVariant[] {
  const q = sanitizeSearch(raw);
  if (!snapshot || q.length < 2) return [];
  const words = fold(q).split(" ").filter(Boolean);
  const out: CachedVariant[] = [];
  for (const v of snapshot.variants) {
    const hay = [v.sku, v.variant_name, v.product_code, v.product_name_en, v.product_name_ar, v.brand_name].map(fold).join(" ");
    if (words.every((w) => hay.includes(w))) {
      out.push(v);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function priceMap(snapshot: CatalogSnapshot | null): Map<string, number> {
  const map = new Map<string, number>();
  for (const v of snapshot?.variants ?? []) if (v.price !== null) map.set(v.variant_id, v.price);
  return map;
}

export interface IndicativeTotals {
  /** Sum of list price × quantity over the lines with a known price. */
  total: number;
  /** Lines without a cached price. */
  missing: number;
}

/** Indicative list-price total (before discounts and VAT). Display only: it is never sent. */
export function indicativeTotals(lines: readonly Pick<BuilderLine, "variant_id" | "quantity">[], prices: ReadonlyMap<string, number>): IndicativeTotals {
  let total = 0;
  let missing = 0;
  for (const l of lines) {
    const p = prices.get(l.variant_id);
    if (p === undefined) missing++;
    else total += Math.round(p * l.quantity * 100) / 100;
  }
  return { total: Math.round(total * 100) / 100, missing };
}

// ---------------------------------------------------------------------------
// Builder copy kept on the device
// ---------------------------------------------------------------------------

/** "new" for /orders/new, else the order id of the draft being edited. */
export type DraftSlot = string;
export const NEW_SLOT = "new";

export interface LocalDraft {
  slot: DraftSlot;
  /** Set once the draft was saved (sent or queued); generated on the device. */
  orderId: string | null;
  /** Newest draft version known to be on the server (0 = not created yet). */
  serverVersion: number;
  customerId: string;
  visitId: string | null;
  notes: string;
  lines: BuilderLine[];
  /** Changed since the last save. */
  dirty: boolean;
  updatedAt: string;
}

export interface BuilderSeed {
  orderId: string | null;
  serverVersion: number;
  customerId: string;
  visitId: string | null;
  notes: string;
  lines: BuilderLine[];
}

export type RestoreNotice = "none" | "restored" | "replaced";

/**
 * Which copy the builder opens with. A device copy wins when it has work the
 * server does not (unsaved edits, or saves of it not yet confirmed: waiting,
 * failed or in conflict) AND the server draft has not moved past the version
 * that copy is based on. If the server moved (someone else saved), the server
 * draft is shown and the device copy dropped. A copy whose saves all reached
 * the server is dropped: the order is on the server now.
 *
 * `unconfirmedSaves` = this draft's queue items that are not done.
 */
export function chooseBuilderStart(
  slot: DraftSlot,
  local: LocalDraft | null,
  server: BuilderSeed,
  unconfirmedSaves: number,
): { seed: BuilderSeed; notice: RestoreNotice; dropLocal: boolean } {
  if (!local) return { seed: server, notice: "none", dropLocal: false };
  const neverSaved = local.orderId === null && local.lines.length > 0;
  const hasWork = local.dirty || unconfirmedSaves > 0 || neverSaved;
  if (!hasWork) return { seed: server, notice: "none", dropLocal: true };
  const pendingSaves = unconfirmedSaves;
  if (slot !== NEW_SLOT && local.serverVersion < server.serverVersion && pendingSaves === 0) {
    return { seed: server, notice: local.dirty ? "replaced" : "none", dropLocal: true };
  }
  return {
    seed: {
      orderId: local.orderId ?? server.orderId,
      serverVersion: local.serverVersion,
      customerId: local.customerId,
      visitId: local.visitId,
      notes: local.notes,
      lines: local.lines,
    },
    notice: "restored",
    dropLocal: false,
  };
}
