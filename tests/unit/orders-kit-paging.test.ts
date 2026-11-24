import { describe, expect, it } from "vitest";
import { tableStateToQuery } from "@/components/ui/data-table-params";
import { cleanSearch, filterQuery, hasAnyParam, ilikeAny, pageRequest, tableOptions, type ListSpec } from "@/modules/orders/kit/paging";

const spec: ListSpec = {
  pageSize: 25,
  sortColumns: { number: "order_no", customer: "customer_name", total: "total", created: "created_at" },
  defaultSort: { id: "created", desc: true },
  searchColumns: ["order_no", "customer_name"],
};

describe("pageRequest", () => {
  it("defaults to the first page in the list's own order", () => {
    const r = pageRequest({}, spec);
    expect(r).toMatchObject({ offset: 0, limit: 25, sort: { column: "created_at", ascending: false }, search: "" });
    expect(r.state).toEqual({ pageIndex: 0, pageSize: 25, sorting: [{ id: "created", desc: true }], search: "" });
  });

  it("maps a whitelisted column id to its view column, in either direction", () => {
    expect(pageRequest({ sort: "total" }, spec).sort).toEqual({ column: "total", ascending: true });
    expect(pageRequest({ sort: "-customer" }, spec).sort).toEqual({ column: "customer_name", ascending: false });
  });

  it("ignores a sort the list does not allow (no raw column names reach the query)", () => {
    expect(pageRequest({ sort: "-customer_id" }, spec).sort).toEqual({ column: "created_at", ascending: false });
    expect(pageRequest({ sort: "order_no;drop" }, spec).sort.column).toBe("created_at");
  });

  it("turns ?page= into an offset and clamps nonsense", () => {
    expect(pageRequest({ page: "3" }, spec).offset).toBe(50);
    expect(pageRequest({ page: "-4" }, spec).offset).toBe(0);
    expect(pageRequest({ page: "abc" }, spec).offset).toBe(0);
  });

  it("cleans the search, and drops it when the list has no search columns", () => {
    expect(pageRequest({ q: "  ORD-2026,(x)* " }, spec).search).toBe("ORD-2026 x");
    expect(pageRequest({ q: "abc" }, { ...spec, searchColumns: [] }).search).toBe("");
  });

  it("reads back exactly what the client table writes", () => {
    const state = { pageIndex: 1, pageSize: 25, sorting: [{ id: "customer", desc: false }], search: "عيادة" };
    const r = pageRequest(tableStateToQuery(state, { status: "submitted" }), spec);
    expect(r.state).toEqual(state);
    expect(r.offset).toBe(25);
  });

  it("tableOptions lists the sortable ids for the client hook", () => {
    expect(tableOptions(spec)).toEqual({ pageSize: 25, sortable: ["number", "customer", "total", "created"], defaultSort: { id: "created", desc: true } });
  });
});

describe("cleanSearch / ilikeAny", () => {
  it("keeps Arabic, Latin, digits and . - / +", () => {
    expect(cleanSearch("عيادة د. أحمد")).toBe("عيادة د. أحمد");
    expect(cleanSearch("INV-2026/001 +20")).toBe("INV-2026/001 +20");
  });

  it("removes PostgREST syntax and wildcards", () => {
    expect(cleanSearch(`a,b(c)"d'e%f*g\\h:i`)).toBe("a b c d e f g h i");
    expect(cleanSearch(null)).toBe("");
    expect(cleanSearch("x".repeat(100))).toHaveLength(60);
  });

  it("builds one quoted ilike per column, or null when empty", () => {
    expect(ilikeAny(["order_no", "customer_name"], "ab c")).toBe('order_no.ilike."*ab c*",customer_name.ilike."*ab c*"');
    expect(ilikeAny(["order_no"], " ,, ")).toBeNull();
    expect(ilikeAny([], "abc")).toBeNull();
  });
});

describe("filterQuery / hasAnyParam", () => {
  it("replaces the changed filter, keeps the rest, and resets the page", () => {
    expect(filterQuery({ status: "open", page: "4", sort: "-total", q: "x" }, { customer: "c1" })).toBe("status=open&sort=-total&q=x&customer=c1");
    expect(filterQuery(new URLSearchParams("status=open&page=2"), { status: "paid" })).toBe("status=paid");
  });

  it("removes a filter set to null or empty", () => {
    expect(filterQuery({ status: "open", warehouse: "w" }, { warehouse: null })).toBe("status=open");
    expect(filterQuery({ status: "open" }, { status: "" })).toBe("");
  });

  it("tells whether any filter is set", () => {
    expect(hasAnyParam({ status: "open", page: "2" }, ["customer", "status"])).toBe(true);
    expect(hasAnyParam({ customer: " " }, ["customer"])).toBe(false);
    expect(hasAnyParam(new URLSearchParams("q=a"), ["status"])).toBe(false);
  });
});
