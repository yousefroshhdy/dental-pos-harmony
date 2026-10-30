import { describe, expect, it } from "vitest";
import type { UserContext } from "@/lib/authz/can";
import { fieldSpecs } from "@/modules/reports/forms";
import { EXPORT_KINDS, FILTER_FIELDS } from "@/modules/reports/kinds";
import { exportLocale, filterKeysOf, parseExportFilters, searchParamsToObject } from "@/modules/reports/schemas";

const qs = (s: string) => new URLSearchParams(s);
const parse = (kind: Parameters<typeof parseExportFilters>[0], s: string) => parseExportFilters(kind, qs(s));
const CUSTOMER = "11111111-2222-3333-4444-555555555555";
const owner = { active: true, is_owner: true, permissions: {} } as unknown as UserContext;

describe("searchParamsToObject", () => {
  it("takes the first value, trims, drops empty values and the locale", () => {
    expect(searchParamsToObject(qs("status=open&status=paid&customer=&q=%20x%20&locale=en"))).toEqual({ status: "open", q: "x" });
  });
});

describe("export filter schemas", () => {
  it("orders: list-page status filters with the page's default", () => {
    expect(parse("orders", "")).toEqual({ ok: true, filters: { status: "all" } });
    expect(parse("orders", "status=awaiting&from=2026-10-01&to=2026-10-31")).toEqual({
      ok: true,
      filters: { status: "awaiting", from: "2026-10-01", to: "2026-10-31" },
    });
    expect(parse("order_lines", "status=closed")).toEqual({ ok: true, filters: { status: "closed" } });
  });

  it("rejects unknown statuses, bad dates and reversed ranges (400, not a silent default)", () => {
    expect(parse("orders", "status=bogus")).toEqual({ ok: false, fields: ["status"] });
    expect(parse("orders", "from=2026-02-30")).toEqual({ ok: false, fields: ["from"] });
    expect(parse("orders", "from=30-10-2026")).toEqual({ ok: false, fields: ["from"] });
    expect(parse("orders", "from=2026-10-31&to=2026-10-01")).toEqual({ ok: false, fields: ["to"] });
  });

  it("invoices: defaults to open; a bucket implies open; customer must be an id", () => {
    expect(parse("invoices", "")).toEqual({ ok: true, filters: { status: "open" } });
    expect(parse("invoices", `status=paid&bucket=d31_60&customer=${CUSTOMER}`)).toEqual({
      ok: true,
      filters: { status: "open", bucket: "d31_60", customer: CUSTOMER },
    });
    expect(parse("invoices", "customer=1;drop")).toEqual({ ok: false, fields: ["customer"] });
    expect(parse("invoices", "bucket=d0")).toEqual({ ok: false, fields: ["bucket"] });
  });

  it("payments, visits, tracking", () => {
    expect(parse("payments", "status=unallocated")).toEqual({ ok: true, filters: { status: "unallocated" } });
    expect(parse("visits", "")).toEqual({ ok: true, filters: { who: "mine" } });
    expect(parse("visits", "status=completed&who=all")).toEqual({ ok: true, filters: { status: "completed", who: "all" } });
    expect(parse("visits", "who=everyone")).toEqual({ ok: false, fields: ["who"] });
    expect(parse("tracking", "date=2026-10-30")).toEqual({ ok: true, filters: { date: "2026-10-30" } });
    expect(parse("tracking", "date=today")).toEqual({ ok: false, fields: ["date"] });
  });

  it("customers: the customers page's search and filters", () => {
    expect(parse("customers", "q=%D8%B9%D9%8A%D8%A7%D8%AF%D8%A9&stage=active&specialty=ortho")).toEqual({
      ok: true,
      filters: { q: "عيادة", stage: "active", specialty: "ortho" },
    });
    expect(parse("customers", `q=${"x".repeat(81)}`)).toEqual({ ok: false, fields: ["q"] });
    expect(parse("customers", "specialty=a,b")).toEqual({ ok: false, fields: ["specialty"] });
    expect(parse("customers", "territory=nope")).toEqual({ ok: false, fields: ["territory"] });
  });

  it("ignores parameters an export does not know (e.g. the list page's page number)", () => {
    expect(parse("customers", "page=3")).toEqual({ ok: true, filters: {} });
    expect(parse("aging", "status=open")).toEqual({ ok: true, filters: {} });
    expect(parse("stock", "alert=expired")).toEqual({ ok: true, filters: {} });
  });
});

describe("filter forms match the schemas", () => {
  it.each(EXPORT_KINDS)("%s: every form field is a parameter the schema accepts", (kind) => {
    const accepted = filterKeysOf(kind);
    for (const name of FILTER_FIELDS[kind]) expect(accepted, name).toContain(name);
    for (const f of fieldSpecs(kind, owner)) expect(FILTER_FIELDS[kind]).toContain(f.name);
  });

  it("every fixed option a form offers passes validation", () => {
    for (const kind of EXPORT_KINDS) {
      for (const f of fieldSpecs(kind, owner)) {
        if (f.control !== "select") continue;
        for (const code of f.codes) expect(parse(kind, `${f.name}=${code}`).ok, `${kind}.${f.name}=${code}`).toBe(true);
      }
    }
  });
});

describe("exportLocale", () => {
  it("uses ?locale= when valid, else the user's preference", () => {
    expect(exportLocale(qs("locale=en"), "ar")).toBe("en");
    expect(exportLocale(qs("locale=fr"), "ar")).toBe("ar");
    expect(exportLocale(qs(""), "en")).toBe("en");
  });
});
