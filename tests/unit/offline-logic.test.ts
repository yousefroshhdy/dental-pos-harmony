import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENGINE_CODES } from "@/lib/offline/sync";
import type { QueueItem } from "@/lib/offline/types";
import {
  conflictRows,
  countItems,
  flatten,
  formatValue,
  groupItems,
  itemActions,
  normalizeKey,
  statusBadge,
} from "@/modules/offline/logic";

const base: QueueItem = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: "u",
  command: "crm.update_customer",
  args: {},
  groupKey: null,
  summary: null,
  createdAt: "2026-10-29T08:00:00.000Z",
  seq: 1,
  attempts: 0,
  status: "pending",
  lastError: null,
  flag: null,
  staleAcknowledged: false,
  result: null,
  updatedAt: "2026-10-29T08:00:00.000Z",
};
const item = (over: Partial<QueueItem>): QueueItem => ({ ...base, ...over });

describe("offline display rules", () => {
  it("groups items into attention / waiting / done", () => {
    const items = [
      item({ id: "a", status: "pending" }),
      item({ id: "b", status: "failed" }),
      item({ id: "c", status: "conflict" }),
      item({ id: "d", status: "pending", flag: "stale" }),
      item({ id: "e", status: "pending", flag: "stale", staleAcknowledged: true }),
      item({ id: "f", status: "syncing" }),
      item({ id: "g", status: "done" }),
      item({ id: "h", status: "done" }),
    ];
    const g = groupItems(items);
    expect(g.attention.map((i) => i.id)).toEqual(["b", "c", "d"]);
    expect(g.waiting.map((i) => i.id)).toEqual(["a", "e", "f"]);
    expect(g.done.map((i) => i.id)).toEqual(["h", "g"]);
    expect(countItems(items)).toEqual({ unsynced: 6, attention: 3 });
  });

  it("badges: stale wins over pending", () => {
    expect(statusBadge(item({ flag: "stale" }))).toEqual({ key: "stale", tone: "warning" });
    expect(statusBadge(item({ status: "failed" }))).toEqual({ key: "failed", tone: "danger" });
    expect(statusBadge(item({ status: "done" })).key).toBe("done");
  });

  it("actions per state", () => {
    expect(itemActions(item({ status: "failed" }))).toEqual({ retry: true, sendAnyway: false, discard: true });
    expect(itemActions(item({ flag: "stale" }))).toEqual({ retry: false, sendAnyway: true, discard: true });
    expect(itemActions(item({ status: "syncing" }))).toEqual({ retry: false, sendAnyway: false, discard: false });
    expect(itemActions(item({ status: "done" })).discard).toBe(false);
    expect(itemActions(item({ status: "pending" }))).toEqual({ retry: false, sendAnyway: false, discard: true });
  });
});

describe("conflict diff (server vs yours)", () => {
  it("normalizes arg and detail prefixes and flattens nested objects", () => {
    expect(normalizeKey("p_version")).toBe("version");
    expect(normalizeKey("current_version")).toBe("version");
    expect(flatten({ p_changes: { city: "X", tags: ["a"] }, p_version: 2, empty: {} })).toEqual({
      "changes.city": "X",
      "changes.tags": ["a"],
      version: 2,
      empty: {},
    });
  });

  it("lines up the version from update_customer's detail with the item's p_version", () => {
    const rows = conflictRows(
      item({
        status: "conflict",
        args: { p_customer_id: "c-1", p_version: 2, p_changes: { city: "Test City" } },
        lastError: {
          code: "CONFLICT",
          messageKey: "CONFLICT",
          at: base.createdAt,
          conflict: { currentVersion: 3, server: { current_version: 3, updated_at: "2026-10-29T09:00:00Z" } },
        },
      }),
    );
    expect(rows[0]).toEqual({ field: "version", server: "3", yours: "2", differs: true });
    expect(rows).toContainEqual({ field: "changes.city", server: "—", yours: "Test City", differs: false });
    expect(rows).toContainEqual({ field: "updated_at", server: "2026-10-29T09:00:00Z", yours: "—", differs: false });
  });

  it("matches a nested path on one side with a plain key on the other", () => {
    const rows = conflictRows(
      item({
        status: "conflict",
        args: { p_changes: { city: "Mine" } },
        lastError: { code: "CONFLICT", messageKey: "CONFLICT", at: base.createdAt, conflict: { server: { city: "Theirs" } } },
      }),
    );
    expect(rows).toEqual([{ field: "changes.city", server: "Theirs", yours: "Mine", differs: true }]);
  });

  it("uses the payload's own 'yours' when the sender sends one", () => {
    const rows = conflictRows(
      item({
        status: "conflict",
        args: { ignored: 1 },
        lastError: { code: "CONFLICT", messageKey: "CONFLICT", at: base.createdAt, conflict: { server: { a: 1 }, yours: { a: 1 } } },
      }),
    );
    expect(rows).toEqual([{ field: "a", server: "1", yours: "1", differs: false }]);
  });

  it("formats values for display", () => {
    expect(formatValue(null)).toBe("—");
    expect(formatValue(undefined)).toBe("—");
    expect(formatValue("")).toBe("—");
    expect(formatValue(false)).toBe("false");
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe("offline messages", () => {
  const load = (locale: string) =>
    JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "offline.json"), "utf8")) as Record<string, Record<string, unknown>>;

  it.each(["ar", "en"])("%s has a text for every status, badge and engine code", (locale) => {
    const m = load(locale);
    for (const key of ["pending", "syncing", "failed", "conflict", "done", "stale"]) expect(m.status?.[key]).toBeTruthy();
    for (const code of ENGINE_CODES) expect(m.codes?.[code]).toBeTruthy();
    expect(m.commands?.unknown).toBeTruthy();
  });
});
