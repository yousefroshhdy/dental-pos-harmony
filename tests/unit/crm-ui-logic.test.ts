import { describe, expect, it } from "vitest";
import {
  activeCustomerFilters,
  customerGaps,
  customerListFilters,
  customerListHref,
  customerListOrder,
  customerSearchFilter,
  customerTabs,
  parseCustomerTab,
  phoneRemoved,
  telHref,
  whatsappHref,
} from "@/modules/crm/logic";
import { addPhoneSchema, customerListParamsSchema } from "@/modules/crm/schemas";

// Synthetic values only (D-03).
const ID = "40000000-0000-0000-0000-000000000001";
const REP = "20000000-0000-0000-0000-000000000004";

describe("customerGaps (badges on the list and the detail)", () => {
  it("flags a missing phone and a missing pin, in that order", () => {
    expect(customerGaps({ phone_primary: null, latitude: null })).toEqual(["phone_missing", "location_missing"]);
    expect(customerGaps({ phone_primary: "", latitude: "30.0444" })).toEqual(["phone_missing"]);
    expect(customerGaps({ phone_primary: "+201001234567", latitude: null })).toEqual(["location_missing"]);
  });

  it("has no gap when both are present (a zero coordinate is still a coordinate)", () => {
    expect(customerGaps({ phone_primary: "+201001234567", latitude: 30.0444 })).toEqual([]);
    expect(customerGaps({ phone_primary: "+201001234567", latitude: 0 })).toEqual([]);
  });

  it("prefers the view's own flags when the row carries them", () => {
    expect(customerGaps({ phone_primary: null, latitude: 30, phone_missing: false, location_missing: true })).toEqual(["location_missing"]);
  });
});

describe("contact links", () => {
  it("calls any valid Egyptian number", () => {
    expect(telHref("+201001234567")).toBe("tel:+201001234567");
    expect(telHref("+20223456789")).toBe("tel:+20223456789");
  });

  it("opens WhatsApp for mobiles only, digits without the plus", () => {
    expect(whatsappHref("+201001234567")).toBe("https://wa.me/201001234567");
    expect(whatsappHref("+201551234567")).toBe("https://wa.me/201551234567");
    expect(whatsappHref("+20223456789")).toBeNull();
  });

  it("gives no link without a phone or for a malformed one", () => {
    for (const v of [null, undefined, "", "12345", "+14155550100"]) {
      expect(telHref(v)).toBeNull();
      expect(whatsappHref(v)).toBeNull();
    }
  });
});

describe("customer list filters → query", () => {
  const parse = (raw: Record<string, string>) => customerListParamsSchema.parse(raw);

  it("keeps the new filters and drops invalid values", () => {
    expect(parse({ rep: REP, overdue: "1", phone: "missing", location: "missing" })).toMatchObject({
      rep: REP,
      overdue: "1",
      phone: "missing",
      location: "missing",
    });
    expect(parse({ rep: "nobody", overdue: "yes", phone: "present", location: "x" })).toMatchObject({
      rep: undefined,
      overdue: undefined,
      phone: undefined,
      location: undefined,
    });
  });

  it("maps each filter to one column condition", () => {
    expect(
      customerListFilters(parse({ stage: "lead", territory: ID, specialty: "GP", rep: REP, overdue: "1", phone: "missing", location: "missing" })),
    ).toEqual([
      { op: "eq", column: "lifecycle_stage", value: "lead" },
      { op: "eq", column: "territory_id", value: ID },
      { op: "eq", column: "specialty_code", value: "GP" },
      { op: "eq", column: "primary_rep_employee_id", value: REP },
      { op: "eq", column: "is_overdue", value: true },
      { op: "eq", column: "phone_missing", value: true },
      { op: "eq", column: "location_missing", value: true },
    ]);
  });

  it("turns the search into the same name/number/phone filter as before", () => {
    expect(customerListFilters(parse({ q: "0100 123" }))).toEqual([{ op: "or", value: customerSearchFilter("0100 123") }]);
    expect(customerListFilters(parse({ q: "   " }))).toEqual([]);
    expect(customerListFilters(parse({}))).toEqual([]);
  });

  it("orders by a known column, with the id as a stable tie-break", () => {
    expect(customerListOrder([])).toEqual([
      { column: "display_name", ascending: true },
      { column: "id", ascending: true },
    ]);
    expect(customerListOrder([{ id: "balance", desc: true }])).toEqual([
      { column: "balance", ascending: false },
      { column: "id", ascending: true },
    ]);
    expect(customerListOrder([{ id: "phone_primary", desc: false }])[0]).toEqual({ column: "display_name", ascending: true });
  });

  it("lists the active filters (search and page are not filters)", () => {
    expect(activeCustomerFilters(parse({ q: "x", page: "3" }))).toEqual([]);
    expect(activeCustomerFilters(parse({ stage: "active", phone: "missing", overdue: "1" }))).toEqual(["stage", "overdue", "phone"]);
  });

  it("builds filter links that keep the other filters and go back to page 1", () => {
    const current = parse({ q: "clinic", stage: "lead", phone: "missing", page: "4" });
    expect(customerListHref(current, { phone: undefined })).toBe("/customers?q=clinic&stage=lead");
    expect(customerListHref(current, { overdue: "1" })).toBe("/customers?q=clinic&stage=lead&overdue=1&phone=missing");
    expect(customerListHref(current, null)).toBe("/customers?q=clinic");
    expect(customerListHref(parse({}), null)).toBe("/customers");
  });
});

describe("customer detail tabs", () => {
  const holder = (...perms: string[]) => (p: string) => perms.includes(p);

  it("shows a tab only with the permission its data needs", () => {
    expect(customerTabs(holder())).toEqual(["overview", "activity"]);
    expect(customerTabs(holder("field.visit.read", "sales.order.read", "finance.invoice.read"))).toEqual([
      "overview",
      "visits",
      "orders",
      "invoices",
      "activity",
    ]);
    expect(customerTabs(holder("sales.order.read"))).toEqual(["overview", "orders", "activity"]);
  });

  it("falls back to the overview for an unknown or hidden tab", () => {
    const tabs = customerTabs(holder("sales.order.read"));
    expect(parseCustomerTab("orders", tabs)).toBe("orders");
    expect(parseCustomerTab("invoices", tabs)).toBe("overview");
    expect(parseCustomerTab(["activity", "orders"], tabs)).toBe("activity");
    expect(parseCustomerTab(undefined, tabs)).toBe("overview");
  });
});

describe("adding a phone later", () => {
  it("normalises the phone and needs the record version", () => {
    expect(addPhoneSchema.parse({ customer_id: ID, version: "2", phone_primary: "٠١٠٠١٢٣٤٥٦٧" })).toEqual({
      customer_id: ID,
      version: 2,
      phone_primary: "+201001234567",
    });
    expect(addPhoneSchema.safeParse({ customer_id: ID, version: "2" }).success).toBe(false);
    expect(addPhoneSchema.safeParse({ customer_id: ID, version: "2", phone_primary: "12345" }).success).toBe(false);
    expect(addPhoneSchema.safeParse({ customer_id: ID, phone_primary: "01001234567" }).success).toBe(false);
  });

  it("treats clearing a saved phone as a removal (the database refuses it)", () => {
    expect(phoneRemoved("+201001234567", undefined)).toBe(true);
    expect(phoneRemoved("+201001234567", "  ")).toBe(true);
    expect(phoneRemoved("+201001234567", "01001234567")).toBe(false);
    expect(phoneRemoved(null, undefined)).toBe(false);
  });
});
