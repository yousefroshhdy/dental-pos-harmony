import type { Json, JsonObject, QueueItem } from "@/lib/offline/types";

/** Pure display rules for the sync screen and the header indicator. */

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

export const isStale = (item: QueueItem) => item.flag === "stale" && !item.staleAcknowledged;

/** Needs a decision from the user: failed, conflict, or older than 7 days. */
export const needsAttention = (item: QueueItem) =>
  item.status === "failed" || item.status === "conflict" || (item.status === "pending" && isStale(item));

export interface QueueGroups {
  attention: QueueItem[];
  waiting: QueueItem[];
  done: QueueItem[];
}

export function groupItems(items: QueueItem[]): QueueGroups {
  const groups: QueueGroups = { attention: [], waiting: [], done: [] };
  for (const item of items) {
    if (item.status === "done") groups.done.push(item);
    else if (needsAttention(item)) groups.attention.push(item);
    else groups.waiting.push(item);
  }
  // Most recent confirmations first; the rest keep queue order.
  groups.done.reverse();
  return groups;
}

export interface QueueCounts {
  /** Not yet confirmed by the server (everything except done). */
  unsynced: number;
  attention: number;
}

export function countItems(items: QueueItem[]): QueueCounts {
  let unsynced = 0;
  let attention = 0;
  for (const item of items) {
    if (item.status !== "done") unsynced++;
    if (needsAttention(item)) attention++;
  }
  return { unsynced, attention };
}

/** Badge key and tone for an item: stale wins over pending. */
export function statusBadge(item: QueueItem): { key: string; tone: Tone } {
  if (item.status === "pending" && isStale(item)) return { key: "stale", tone: "warning" };
  switch (item.status) {
    case "pending":
      return { key: "pending", tone: "neutral" };
    case "syncing":
      return { key: "syncing", tone: "info" };
    case "failed":
      return { key: "failed", tone: "danger" };
    case "conflict":
      return { key: "conflict", tone: "warning" };
    case "done":
      return { key: "done", tone: "success" };
  }
}

/** What the user may do with an item on the sync screen. */
export function itemActions(item: QueueItem): { retry: boolean; sendAnyway: boolean; discard: boolean } {
  const stale = item.status === "pending" && isStale(item);
  return {
    retry: item.status === "failed" || item.status === "conflict",
    sendAnyway: stale,
    discard: item.status !== "syncing" && item.status !== "done",
  };
}

// ---------------------------------------------------------------------------
// Conflict diff ("server vs yours")
// ---------------------------------------------------------------------------

export interface DiffRow {
  field: string;
  server: string;
  yours: string;
  differs: boolean;
}

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Command arg names carry a `p_` prefix and server detail a `current_` one; compare without them. */
export const normalizeKey = (key: string) => key.replace(/^p_/, "").replace(/^current_/, "");

/** Flattens nested objects to dotted paths with normalized keys: { p_changes: { phone } } → { "changes.phone" }. */
export function flatten(obj: JsonObject, prefix = ""): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [rawKey, value] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${normalizeKey(rawKey)}` : normalizeKey(rawKey);
    if (isObject(value) && Object.keys(value).length > 0) Object.assign(out, flatten(value, key));
    else out[key] = value;
  }
  return out;
}

export function formatValue(value: Json | undefined): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

const leaf = (path: string) => path.slice(path.lastIndexOf(".") + 1);

/**
 * Field-by-field comparison of the server's values and the user's, from the
 * conflict payload when the server sent one (falls back to the item's args for
 * "yours"). A nested path on one side matches a plain key on the other by its
 * last segment, so { changes.phone } lines up with { phone }.
 */
export function conflictRows(item: QueueItem): DiffRow[] {
  const conflict = item.lastError?.conflict;
  const server = flatten({
    ...(conflict?.server ?? {}),
    ...(conflict?.currentVersion !== undefined ? { version: conflict.currentVersion } : {}),
  });
  const yours = flatten(conflict?.yours ?? item.args);

  const rows: DiffRow[] = [];
  const usedServer = new Set<string>();
  for (const [field, mine] of Object.entries(yours)) {
    const match = field in server ? field : leaf(field) in server ? leaf(field) : null;
    if (match) usedServer.add(match);
    const theirs = match ? server[match] : undefined;
    rows.push({ field, server: formatValue(theirs), yours: formatValue(mine), differs: match !== null && JSON.stringify(theirs) !== JSON.stringify(mine) });
  }
  for (const [field, theirs] of Object.entries(server)) {
    if (!usedServer.has(field)) rows.push({ field, server: formatValue(theirs), yours: "—", differs: false });
  }
  // Differences first, then the rest in their original order.
  return rows.sort((a, b) => Number(b.differs) - Number(a.differs));
}
