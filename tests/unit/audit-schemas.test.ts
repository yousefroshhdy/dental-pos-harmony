import { describe, expect, it } from "vitest";
import { parseAuditSearch, parseRecordRoute, splitTableRef } from "@/modules/audit/schemas";

const OWNER = "00000000-0000-0000-0000-0000000000A1";

describe("parseAuditSearch", () => {
  it("reads every filter", () => {
    const { filters, invalid } = parseAuditSearch({
      table: "crm.customers",
      record: "  40000000-0000-0000-0000-000000000001 ",
      actor: OWNER,
      from: "2026-10-01",
      to: "2026-10-30",
      action: "update",
      before: "120",
      reveal: "1",
    });
    expect(invalid).toEqual([]);
    expect(filters).toEqual({
      tableSchema: "crm",
      tableName: "customers",
      recordId: "40000000-0000-0000-0000-000000000001",
      actorUserId: OWNER.toLowerCase(),
      from: "2026-10-01",
      to: "2026-10-30",
      action: "UPDATE",
      beforeId: 120,
      reveal: true,
    });
  });

  it("defaults to no filters and no reveal", () => {
    expect(parseAuditSearch({})).toEqual({ filters: { reveal: false }, invalid: [] });
    expect(parseAuditSearch({ table: "", record: "   ", reveal: "yes" }).filters).toEqual({ reveal: false });
  });

  it("drops and reports invalid values instead of failing the search", () => {
    const { filters, invalid } = parseAuditSearch({
      table: "crm.customers;drop",
      actor: "not-a-uuid",
      from: "2026-13-01",
      action: "TRUNCATE",
      before: "-5",
      record: "x".repeat(201),
    });
    expect(filters).toEqual({ reveal: false });
    expect(invalid.sort()).toEqual(["action", "actor", "before", "from", "record", "table"]);
  });

  it("rejects a reversed date range", () => {
    const { filters, invalid } = parseAuditSearch({ from: "2026-10-30", to: "2026-10-01" });
    expect(invalid).toEqual(["range"]);
    expect(filters.from).toBeUndefined();
    expect(filters.to).toBeUndefined();
  });

  it("takes the first of repeated parameters", () => {
    expect(parseAuditSearch({ action: ["DELETE", "INSERT"] }).filters.action).toBe("DELETE");
  });
});

describe("table refs and record routes", () => {
  it("splits schema.table", () => {
    expect(splitTableRef("crm.customers")).toEqual(["crm", "customers"]);
    expect(splitTableRef("CRM.Customers")).toEqual(["crm", "customers"]);
    expect(splitTableRef("crm")).toBeNull();
    expect(splitTableRef("crm.customers.extra")).toBeNull();
    expect(splitTableRef("crm.cust-omers")).toBeNull();
    expect(splitTableRef(null)).toBeNull();
  });

  it("parses the timeline route, decoding the segments", () => {
    expect(parseRecordRoute("crm.customers", "40000000-0000-0000-0000-000000000001")).toEqual({
      schema: "crm",
      table: "customers",
      recordId: "40000000-0000-0000-0000-000000000001",
    });
    expect(parseRecordRoute("crm.customers", "a%20b")?.recordId).toBe("a b");
    expect(parseRecordRoute("crm.customers", "%E0%A4%A")?.recordId).toBe("%E0%A4%A");
    expect(parseRecordRoute("customers", "x")).toBeNull();
    expect(parseRecordRoute("crm.customers", "%20")).toBeNull();
  });
});
