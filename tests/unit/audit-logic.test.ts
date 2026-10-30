import { describe, expect, it } from "vitest";
import {
  actionTone,
  actorName,
  auditErrorCode,
  displayValue,
  fieldChanges,
  filtersToQuery,
  historyHref,
  isBlockValue,
  maskedCategories,
  maskedCategory,
  nextBeforeId,
  recordHref,
  stableJson,
  withQuery,
} from "@/modules/audit/logic";
import type { AuditEntry } from "@/modules/audit/types";

const CUSTOMER = "40000000-0000-0000-0000-000000000001";
const OWNER = "00000000-0000-0000-0000-0000000000a1";

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 10,
    occurred_at: "2026-10-30T08:00:00Z",
    actor_user_id: OWNER,
    actor_name_en: "Owner",
    actor_name_ar: "المالك",
    action: "UPDATE",
    table_schema: "crm",
    table_name: "customers",
    record_id: CUSTOMER,
    changed_fields: null,
    request_id: null,
    old_data: null,
    new_data: null,
    masked: null,
    ...over,
  };
}

describe("maskedCategory", () => {
  it("reads the category of a masked value", () => {
    expect(maskedCategory("[masked:phone]")).toBe("phone");
    expect(maskedCategory("[masked:credit_limit]")).toBe("credit_limit");
    expect(maskedCategory("[masked:something_new]")).toBe("other");
  });
  it("ignores ordinary values", () => {
    expect(maskedCategory("+201000000009")).toBeNull();
    expect(maskedCategory(42)).toBeNull();
    expect(maskedCategory(null)).toBeNull();
    expect(maskedCategory(undefined)).toBeNull();
    expect(maskedCategory("masked:phone")).toBeNull();
  });
});

describe("fieldChanges", () => {
  it("lists the trigger's changed fields of an update, alphabetically, old → new", () => {
    const changes = fieldChanges(
      entry({
        changed_fields: ["phone_primary", "display_name", "credit_limit"],
        old_data: { display_name: "Dr. A Clinic", phone_primary: "[masked:phone]", credit_limit: 0, city: "Cairo" },
        new_data: { display_name: "Dr. B Clinic", phone_primary: "[masked:phone]", credit_limit: "[masked:credit_limit]", city: "Cairo" },
        masked: { phone_primary: "phone", credit_limit: "credit_limit" },
      }),
    );
    expect(changes.map((c) => c.field)).toEqual(["credit_limit", "display_name", "phone_primary"]);
    expect(changes[1]).toEqual({ field: "display_name", kind: "changed", before: "Dr. A Clinic", after: "Dr. B Clinic", masked: null });
    expect(changes[0]?.masked).toBe("credit_limit");
    expect(changes[2]?.masked).toBe("phone");
  });

  it("compares the images when changed_fields is missing (key order does not matter)", () => {
    const changes = fieldChanges(
      entry({
        old_data: { a: 1, b: { x: 1, y: 2 }, c: null },
        new_data: { a: 1, b: { y: 2, x: 1 }, c: "set", d: null },
      }),
    );
    expect(changes).toEqual([{ field: "c", kind: "added", before: null, after: "set", masked: null }]);
  });

  it("marks cleared values as removed", () => {
    const [change] = fieldChanges(entry({ changed_fields: ["notes"], old_data: { notes: "x" }, new_data: { notes: null } }));
    expect(change?.kind).toBe("removed");
  });

  it("an insert lists the non-empty new values", () => {
    const changes = fieldChanges(entry({ action: "INSERT", new_data: { id: CUSTOMER, name: "N", email: null } }));
    expect(changes.map((c) => [c.field, c.kind, c.before])).toEqual([
      ["id", "added", undefined],
      ["name", "added", undefined],
    ]);
  });

  it("a delete lists the non-empty old values", () => {
    const changes = fieldChanges(entry({ action: "DELETE", old_data: { id: "r1", phone: "[masked:phone]", notes: null } }));
    expect(changes.map((c) => [c.field, c.kind, c.after, c.masked])).toEqual([
      ["id", "removed", undefined, null],
      ["phone", "removed", undefined, "phone"],
    ]);
  });

  it("uses the masked map when the value itself is not a masked string", () => {
    const [change] = fieldChanges(entry({ changed_fields: ["payload"], old_data: { payload: {} }, new_data: { payload: { a: 1 } }, masked: { payload: "balance" } }));
    expect(change?.masked).toBe("balance");
  });

  it("copes with missing images", () => {
    expect(fieldChanges(entry({ changed_fields: [] }))).toEqual([]);
  });
});

describe("value display", () => {
  it("formats scalars and structures", () => {
    expect(displayValue(null)).toBeNull();
    expect(displayValue(undefined)).toBeNull();
    expect(displayValue("x")).toBe("x");
    expect(displayValue(0)).toBe("0");
    expect(displayValue(false)).toBe("false");
    expect(displayValue({ a: [1] })).toBe('{"a":[1]}');
    expect(isBlockValue({ a: 1 })).toBe(true);
    expect(isBlockValue([1])).toBe(true);
    expect(isBlockValue("x")).toBe(false);
    expect(isBlockValue(null)).toBe(false);
  });
  it("stableJson ignores key order", () => {
    expect(stableJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(stableJson({ a: [{ c: 2, d: 1 }], b: 1 }));
    expect(stableJson(undefined)).not.toBe(stableJson(null));
  });
});

describe("recordHref", () => {
  it("links records whose table has a page", () => {
    expect(recordHref(entry())).toBe(`/customers/${CUSTOMER}`);
    expect(recordHref(entry({ table_schema: "sales", table_name: "orders", record_id: "o1" }))).toBe("/orders/o1");
    expect(recordHref(entry({ table_schema: "finance", table_name: "payments", record_id: "p1" }))).toBe("/finance/payments/p1");
    expect(recordHref(entry({ table_schema: "wf", table_name: "approval_requests", record_id: "a1" }))).toBe("/approvals/a1");
  });
  it("links child rows through their parent id from the row image", () => {
    expect(recordHref(entry({ table_schema: "sales", table_name: "order_items", record_id: "i1", new_data: { order_id: "o1" } }))).toBe("/orders/o1");
    expect(recordHref(entry({ table_schema: "authz", table_name: "user_roles", record_id: "x", action: "DELETE", old_data: { user_id: OWNER } }))).toBe(
      `/admin/users/${OWNER}`,
    );
    expect(recordHref(entry({ table_schema: "catalog", table_name: "price_list_items", record_id: null, new_data: { price_list_id: "pl1" } }))).toBe(
      "/catalog/price-lists/pl1",
    );
  });
  it("has no link for tables without a page, missing ids or masked parent ids", () => {
    expect(recordHref(entry({ table_schema: "perf", table_name: "kpi_targets", record_id: "k1" }))).toBeNull();
    expect(recordHref(entry({ record_id: null }))).toBeNull();
    expect(recordHref(entry({ table_schema: "sales", table_name: "order_items", new_data: {} }))).toBeNull();
    expect(recordHref(entry({ table_schema: "core", table_name: "employees", new_data: { user_id: "[masked:other]" } }))).toBeNull();
  });
  it("encodes ids for the path", () => {
    expect(recordHref(entry({ record_id: "a/b" }))).toBe("/customers/a%2Fb");
  });
});

describe("historyHref", () => {
  it("builds the timeline path", () => {
    expect(historyHref("crm", "customers", CUSTOMER)).toBe(`/audit/crm.customers/${CUSTOMER}`);
    expect(historyHref("crm", "customers", "a b")).toBe("/audit/crm.customers/a%20b");
    expect(historyHref("catalog", "price_list_items", null)).toBeNull();
  });
});

describe("actors, tones, errors", () => {
  it("names the actor in the viewer's locale", () => {
    expect(actorName("ar", entry())).toBe("المالك");
    expect(actorName("en", entry())).toBe("Owner");
    expect(actorName("en", entry({ actor_name_en: null, actor_name_ar: null }))).toBe("00000000");
    expect(actorName("en", entry({ actor_user_id: null }))).toBeNull();
  });
  it("tones actions", () => {
    expect(actionTone("INSERT")).toBe("success");
    expect(actionTone("UPDATE")).toBe("info");
    expect(actionTone("DELETE")).toBe("danger");
  });
  it("maps errors to audit messages", () => {
    expect(auditErrorCode({ code: "PERMISSION_DENIED", messageKey: "PERMISSION_DENIED" })).toBe("PERMISSION_DENIED");
    expect(auditErrorCode({ code: "VALIDATION", messageKey: "VALIDATION" })).toBe("VALIDATION");
    expect(auditErrorCode({ code: "SOMETHING", messageKey: "UNAVAILABLE" })).toBe("UNAVAILABLE");
    expect(auditErrorCode({ code: "SOMETHING", messageKey: "CONFLICT" })).toBe("UNKNOWN");
  });
  it("collects masked categories across entries", () => {
    expect(maskedCategories([entry({ masked: { a: "phone", b: "gps" } }), entry({ masked: { c: "phone" } }), entry()])).toEqual(["gps", "phone"]);
  });
});

describe("URLs and paging", () => {
  it("builds query strings without empty values", () => {
    expect(withQuery("/audit", { table: "crm.customers", record: undefined, reveal: true, before: 12, actor: "" })).toBe(
      "/audit?table=crm.customers&reveal=1&before=12",
    );
    expect(withQuery("/audit", { reveal: false })).toBe("/audit");
  });
  it("round-trips filters to the query", () => {
    expect(
      filtersToQuery({ tableSchema: "crm", tableName: "customers", recordId: "r", actorUserId: OWNER, from: "2026-10-01", to: "2026-10-30", action: "UPDATE", beforeId: 5, reveal: false }),
    ).toEqual({ table: "crm.customers", record: "r", actor: OWNER, from: "2026-10-01", to: "2026-10-30", action: "UPDATE", reveal: false });
    expect(filtersToQuery({ tableSchema: "crm", reveal: true }).table).toBeUndefined();
  });
  it("offers an older page only after a full page", () => {
    expect(nextBeforeId([{ id: 9 }, { id: 7 }, { id: 8 }], 3)).toBe(7);
    expect(nextBeforeId([{ id: 9 }], 3)).toBeNull();
  });
});
