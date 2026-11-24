import { describe, expect, it } from "vitest";
import { readTableParams } from "@/components/ui/data-table-params";
import { firstParam, hrefWithParam, pickParam, rangeOf, sanitizeSearch, searchFilter } from "@/lib/list-query";
import { employeeStatusesFor, sortColumn, USERS_TABLE } from "@/modules/admin/tables";
import { inboxOrder } from "@/modules/approvals/tables";
import { priceRange, productSortColumn } from "@/modules/catalog/tables";
import { historyRequested } from "@/modules/imports/tables";
import { coverageOrder } from "@/modules/planning/tables";

// Phase P step 2b (B2c): the pure pieces behind the server-paged lists.

describe("rangeOf", () => {
  it("turns an offset and a page size into an inclusive PostgREST range", () => {
    expect(rangeOf(0, 25)).toEqual([0, 24]);
    expect(rangeOf(50, 25)).toEqual([50, 74]);
  });
  it("never goes below zero or below one row", () => {
    expect(rangeOf(-10, 25)).toEqual([0, 24]);
    expect(rangeOf(0, 0)).toEqual([0, 0]);
    expect(rangeOf(2.7, 10.9)).toEqual([2, 11]);
  });
});

describe("sanitizeSearch / searchFilter", () => {
  it("drops the characters that would end a PostgREST value or group, and LIKE wildcards", () => {
    expect(sanitizeSearch("a,b(c)d")).toBe("a b c d");
    expect(sanitizeSearch(`x"y'z\\w`)).toBe("x y z w");
    expect(sanitizeSearch("100% *all* a_b")).toBe("100 all a b");
    expect(sanitizeSearch("dr.sara@clinic.eg")).toBe("dr.sara@clinic.eg");
  });
  it("keeps Arabic text and collapses whitespace", () => {
    expect(sanitizeSearch("  عيادة   أسنان  ")).toBe("عيادة أسنان");
  });
  it("cuts long input", () => {
    expect(sanitizeSearch("x".repeat(500)).length).toBe(100);
    expect(sanitizeSearch("abcdef", 3)).toBe("abc");
  });
  it("builds one ilike term per column", () => {
    expect(searchFilter(["code", "name_en"], "rdt")).toBe('code.ilike."*rdt*",name_en.ilike."*rdt*"');
  });
  it("returns null when nothing searchable is left (no filter, not an empty match)", () => {
    expect(searchFilter(["code"], "")).toBeNull();
    expect(searchFilter(["code"], " ,() ")).toBeNull();
    expect(searchFilter([], "abc")).toBeNull();
  });
  it("an injection attempt stays inside one value", () => {
    const or = searchFilter(["name_en"], "x),id.not.is.null,(name_en.ilike.*")!;
    expect(or.split(",")).toHaveLength(1);
    expect(or).not.toContain("(");
    expect(or.match(/"/g)).toHaveLength(2);
  });
});

describe("pickParam / firstParam", () => {
  it("accepts only allow-listed values", () => {
    expect(pickParam({ status: "active" }, "status", ["active", "all"] as const, "all")).toBe("active");
    expect(pickParam({ status: "evil" }, "status", ["active", "all"] as const, "all")).toBe("all");
    expect(pickParam({}, "status", ["active", "all"] as const, "all")).toBe("all");
    expect(pickParam({ status: ["suspended", "active"] }, "status", ["active", "suspended"] as const, "active")).toBe("suspended");
  });
  it("takes the first of repeated values", () => {
    expect(firstParam({ q: ["a", "b"] }, "q")).toBe("a");
    expect(firstParam({}, "q")).toBeUndefined();
  });
});

describe("hrefWithParam", () => {
  it("sets the filter, keeps search and sort, and goes back to page 1", () => {
    expect(hrefWithParam("/admin/users", { q: "sara", sort: "-created_at", page: "3" }, "status", "active")).toBe(
      "/admin/users?q=sara&sort=-created_at&status=active",
    );
  });
  it("removes the parameter for the default chip", () => {
    expect(hrefWithParam("/approvals", { tab: "mine", page: "2" }, "tab", null)).toBe("/approvals");
  });
  it("replaces an existing value and keeps repeated other params", () => {
    expect(hrefWithParam("/x", { status: "a", k: ["1", "2"] }, "status", "b")).toBe("/x?k=1&k=2&status=b");
  });
});

describe("admin tables", () => {
  it("sorts the name column in the UI language", () => {
    expect(sortColumn("name", "ar", "employee_no")).toBe("full_name_ar");
    expect(sortColumn("name", "en", "employee_no")).toBe("full_name_en");
    expect(sortColumn("name", "ar", "code", { en: "name_en", ar: "name_ar" })).toBe("name_ar");
    expect(sortColumn(undefined, "ar", "employee_no")).toBe("employee_no");
    expect(sortColumn("status", "en", "employee_no")).toBe("status");
  });
  it("ignores a sort column the server cannot order by", () => {
    expect(readTableParams({ sort: "-password" }, USERS_TABLE).sorting).toEqual([{ id: "employee_no", desc: false }]);
    expect(readTableParams({ sort: "-created_at" }, USERS_TABLE).sorting).toEqual([{ id: "created_at", desc: true }]);
  });
  it("maps the employee filter to the same statuses as logic.matchesEmployeeFilter", () => {
    expect(employeeStatusesFor("all")).toBeNull();
    expect(employeeStatusesFor("inactive")).toEqual({ include: true, statuses: ["suspended", "terminated"] });
    expect(employeeStatusesFor("current")).toEqual({ include: false, statuses: ["suspended", "terminated"] });
  });
});

describe("approvals inbox order", () => {
  it("keeps each tab's natural order without a user sort", () => {
    expect(inboxOrder("decide", undefined)).toEqual({ column: "stage_started_at", ascending: true });
    expect(inboxOrder("mine", undefined)).toEqual({ column: "created_at", ascending: false });
    expect(inboxOrder("decided", undefined)).toEqual({ column: "my_decided_at", ascending: false });
  });
  it("follows the user's sort", () => {
    expect(inboxOrder("decided", { id: "waiting", desc: true })).toEqual({ column: "stage_started_at", ascending: false });
    expect(inboxOrder("decide", { id: "created_at", desc: false })).toEqual({ column: "created_at", ascending: true });
  });
});

describe("catalog tables", () => {
  it("shows a single price or a range, ignoring unpriced variants", () => {
    expect(priceRange([])).toBeNull();
    expect(priceRange([null, null])).toBeNull();
    expect(priceRange([2650, null, 5000, 3100])).toEqual({ min: 2650, max: 5000 });
    expect(priceRange([120])).toEqual({ min: 120, max: 120 });
  });
  it("maps sort ids to view columns", () => {
    expect(productSortColumn("name", "ar")).toBe("name_ar");
    expect(productSortColumn("name", "en")).toBe("name_en");
    expect(productSortColumn("brand", "en")).toBe("brand_name");
    expect(productSortColumn("drop table", "en")).toBe("code");
  });
});

describe("planning coverage order", () => {
  it("defaults to the worklist order and ends on a unique key", () => {
    const order = coverageOrder(undefined);
    expect(order.map((o) => o.column)).toEqual(["is_overdue", "overdue_days", "customer_name", "customer_id"]);
    expect(order[0]).toMatchObject({ ascending: false });
  });
  it("uses an allowed user sort, never-visited first when ascending", () => {
    expect(coverageOrder({ id: "last_visit_on", desc: false })[0]).toEqual({ column: "last_visit_on", ascending: true, nullsFirst: true });
    expect(coverageOrder({ id: "last_visit_on", desc: true })[0]).toEqual({ column: "last_visit_on", ascending: false, nullsFirst: false });
  });
  it("ignores a column that is not sortable", () => {
    expect(coverageOrder({ id: "employee_id", desc: false })[0]?.column).toBe("is_overdue");
  });
});

describe("imports history tab", () => {
  it("opens when the URL pages, sorts, searches or filters the history", () => {
    expect(historyRequested({})).toBe(false);
    expect(historyRequested({ kind: "customers" })).toBe(false);
    expect(historyRequested({ page: "2" })).toBe(true);
    expect(historyRequested({ status: "failed" })).toBe(true);
    expect(historyRequested({ tab: "history" })).toBe(true);
    expect(historyRequested({ tab: "upload" })).toBe(false);
  });
});
