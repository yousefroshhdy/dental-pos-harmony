import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Grant, Scope, UserContext } from "@/lib/authz/can";
import { handleExport, type ExportDeps } from "@/modules/reports/export";
import type { Db } from "@/modules/reports/sources";

// ---------------------------------------------------------------------------
// A minimal stand-in for the user-session Supabase client: records every
// builder call and serves `range(from, to)` slices of canned rows.
// ---------------------------------------------------------------------------

type Call = [method: string, ...args: unknown[]];
interface Recorded {
  target: string;
  calls: Call[];
}
type Source = Record<string, unknown>[] | { error: { code: string; message: string } };
type Provider = (target: string, calls: Call[], from: number, to: number) => Source | undefined;

/** Answers the export log RPCs (api.log_export / api.log_export_result); default: accepted, export id 101. */
type Gate = (fn: string, args: Record<string, unknown>) => { data: unknown; error: { code: string; message: string } | null };
const ACCEPT: Gate = (fn) => ({ data: fn === "log_export" ? 101 : null, error: null });
const LOG_RPCS = new Set(["log_export", "log_export_result"]);

function mockDb(provider: Provider, maxRows = Number.MAX_SAFE_INTEGER, gate: Gate = ACCEPT) {
  const queries: Recorded[] = [];
  const logs: { fn: string; args: Record<string, unknown> }[] = [];
  const builder = (target: string, initial: Call[] = []) => {
    const rec: Recorded = { target, calls: [...initial] };
    queries.push(rec);
    let range: [number, number] = [0, 999];
    const self: Record<string, unknown> = {};
    for (const m of ["select", "in", "eq", "gt", "gte", "lt", "lte", "is", "or", "order", "neq", "limit"]) {
      self[m] = (...args: unknown[]) => {
        rec.calls.push([m, ...args]);
        return self;
      };
    }
    self.range = (from: number, to: number) => {
      rec.calls.push(["range", from, to]);
      range = [from, to];
      return self;
    };
    self.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      try {
        const src = provider(target, rec.calls, range[0], range[1]) ?? [];
        const result = Array.isArray(src) ? { data: src.slice(range[0], Math.min(range[1] + 1, range[0] + maxRows)), error: null } : { data: null, error: src.error };
        return Promise.resolve(result).then(resolve, reject);
      } catch (e) {
        return Promise.reject(e).then(resolve, reject);
      }
    };
    return self;
  };
  const db = {
    from: vi.fn((view: string) => builder(view)),
    rpc: vi.fn((fn: string, args: Record<string, unknown>) => {
      if (!LOG_RPCS.has(fn)) return builder(`rpc:${fn}`, [["args", args]]);
      logs.push({ fn, args });
      return Promise.resolve(gate(fn, args));
    }),
  };
  return { db: db as unknown as Db, queries, logs, raw: db };
}

function ctx(perms: Record<string, Scope> = {}, extra: Partial<UserContext> = {}): UserContext {
  const permissions: Record<string, Grant> = Object.fromEntries(Object.entries(perms).map(([p, scope]) => [p, { scope, limit: null }]));
  return {
    user_id: "00000000-0000-0000-0000-0000000000aa",
    active: true,
    is_owner: false,
    locale: "ar",
    status: "active",
    employee: { id: "00000000-0000-0000-0000-0000000000e1", employee_no: "E-TEST", full_name_en: "Test Rep", full_name_ar: "مندوب تجريبي", job_title: "rep" },
    permissions,
    ...extra,
  };
}

const OWNER = ctx({}, { is_owner: true });
const NOW = new Date("2026-10-30T10:00:00Z");

function run(kind: string, query: string, user: UserContext, provider: Provider, rowCap = 50_000, maxRows?: number, gate?: Gate) {
  const mock = mockDb(provider, maxRows, gate);
  const createClient = vi.fn(async () => mock.db);
  const deps: ExportDeps = { getContext: async () => user, createClient, rowCap: () => rowCap, now: () => NOW, requestId: () => "req-test" };
  const response = handleExport(new Request(`https://app.test/api/export/${kind}${query}`), kind, deps);
  return { response, mock, createClient };
}

async function body(res: Response): Promise<{ bytes: Uint8Array; text: string; lines: string[] }> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  const lines = text.replace(/^﻿/, "").split("\r\n");
  if (lines.at(-1) === "") lines.pop();
  return { bytes, text, lines };
}

const orders = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    order_no: `SO-TEST-${i}`,
    customer_name: `Test Clinic ${i}`,
    employee_name: "Test Rep",
    status: "approved",
    currency: "EGP",
    payment_terms_days: 30,
    subtotal: 100,
    discount_total: 0,
    tax_total: 14,
    total: 114,
    notes: null,
    submitted_at: "2026-10-29T08:00:00Z",
    approved_at: null,
    created_at: "2026-10-29T07:00:00Z",
  }));

const SALES = { "sales.order.read": "all", "sales.order.export": "all" } as const;

describe("GET /api/export/[kind]: access", () => {
  it("401 without a session, before touching the database", async () => {
    const { response, createClient } = run("orders", "", { ...ctx(), user_id: null }, () => []);
    const res = await response;
    expect(res.status).toBe(401);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("403 without the list permission (or the export permission), before touching the database", async () => {
    for (const user of [ctx(), ctx({ "sales.order.read": "all" }), ctx(SALES, { active: false })]) {
      const { response, createClient } = run("orders", "", user, () => []);
      const res = await response;
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden", requestId: "req-test" });
      expect(createClient).not.toHaveBeenCalled();
    }
  });

  it("404 for an unknown export", async () => {
    const res = await run("salaries", "", OWNER, () => []).response;
    expect(res.status).toBe(404);
  });

  it("400 with the invalid fields", async () => {
    const res = await run("invoices", "?status=bogus&customer=x", OWNER, () => []).response;
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_filters", fields: ["status", "customer"] });
  });

  it("maps a database permission error on the first page to 403, others to 500", async () => {
    const denied = await run("orders", "", ctx(SALES), () => ({ error: { code: "42501", message: "PERMISSION_DENIED: sales.order.read" } })).response;
    expect(denied.status).toBe(403);
    const broken = await run("orders", "", ctx(SALES), () => ({ error: { code: "XX000", message: "boom" } })).response;
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: "export_failed", requestId: "req-test" });
  });

  it("reads only through the injected user-session client; the route never imports the service role", async () => {
    const { response, createClient } = run("orders", "", ctx(SALES), () => orders(1));
    await body(await response);
    expect(createClient).toHaveBeenCalledTimes(1);
    const route = readFileSync(join(__dirname, "../../src/app/api/export/[kind]/route.ts"), "utf8");
    expect(route).toContain('from "@/lib/supabase/server"');
    expect(route).not.toMatch(/supabase\/admin|createServiceClient|SERVICE_ROLE/);
  });
});

describe("GET /api/export/[kind]: the file", () => {
  it("streams UTF-8 CSV with a BOM, CRLF and Arabic headers by default", async () => {
    const res = await run("orders", "", ctx(SALES), () => orders(2)).response;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="honest-orders-2026-10-30.csv"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { bytes, text, lines } = await body(res);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text.replace(/\r\n/g, "")).not.toMatch(/\n/);
    expect(lines[0]?.startsWith("رقم الطلب,الحالة,العميل")).toBe(true);
    expect(lines[1]).toBe("SO-TEST-0,approved,Test Clinic 0,Test Rep,2026-10-29 10:00:00,2026-10-29 11:00:00,,30,EGP,100.00,0.00,14.00,114.00,");
    expect(lines).toHaveLength(3);
  });

  it("uses English headers with ?locale=en", async () => {
    const { lines } = await body(await run("orders", "?locale=en", ctx(SALES), () => orders(1)).response);
    expect(lines[0]?.startsWith("Order no.,Status,Customer,Rep,Created at (Cairo)")).toBe(true);
  });

  it("neutralises formulas in data cells", async () => {
    const rows = [{ ...orders(1)[0], customer_name: '=HYPERLINK("http://example.invalid","x")', notes: "@SUM(A1)" }];
    const { lines } = await body(await run("orders", "?locale=en", ctx(SALES), () => rows).response);
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://example.invalid"",""x"")"`);
    expect(lines[1]?.endsWith(",'@SUM(A1)")).toBe(true);
  });

  it("pages through the view 1,000 rows at a time", async () => {
    const all = orders(2500);
    const { response, mock } = run("orders", "", ctx(SALES), () => all);
    const { lines } = await body(await response);
    expect(lines).toHaveLength(2501);
    const ranges = mock.queries.map((q) => q.calls.find((c) => c[0] === "range")?.slice(1));
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [2500, 3499],
    ]);
  });

  it("keeps paging correctly when PostgREST caps a page below the request (max-rows)", async () => {
    const all = orders(450);
    const { response, mock } = run("orders", "", ctx(SALES), () => all, 50_000, 200);
    const { lines } = await body(await response);
    expect(lines).toHaveLength(451);
    expect(mock.queries.map((q) => q.calls.find((c) => c[0] === "range")?.[1])).toEqual([0, 200, 400, 450]);
  });

  it("cuts the file at the row cap and says so in a final note row", async () => {
    const { lines } = await body(await run("orders", "?locale=en", ctx(SALES), () => orders(5), 3).response);
    expect(lines).toHaveLength(1 + 3 + 1);
    expect(lines.at(-1)).toBe("Truncated: only the first 3 rows are included. Narrow the filters and export again.");
  });

  it("adds no note when the data fits the cap exactly", async () => {
    const { lines } = await body(await run("orders", "", ctx(SALES), () => orders(3), 3).response);
    expect(lines).toHaveLength(4);
    expect(lines.at(-1)?.startsWith("SO-TEST-2,")).toBe(true);
  });

  it("ends with an 'incomplete' note when a later page fails", async () => {
    const all = orders(1500);
    const provider: Provider = (_t, _c, from) => (from === 0 ? all : { error: { code: "57014", message: "canceling statement" } });
    const { lines } = await body(await run("orders", "?locale=en", ctx(SALES), provider).response);
    expect(lines).toHaveLength(1 + 1000 + 1);
    expect(lines.at(-1)).toBe("Incomplete: the export stopped because of an error. Try again.");
  });
});

describe("GET /api/export/[kind]: filters mirror the list pages", () => {
  const callsOf = (mock: ReturnType<typeof mockDb>, target: string) => mock.queries.find((q) => q.target === target)?.calls ?? [];

  it("orders: status set and Cairo day range on created_at", async () => {
    const { response, mock } = run("orders", "?status=awaiting&from=2026-10-01&to=2026-10-31", ctx(SALES), () => []);
    await body(await response);
    const calls = callsOf(mock, "v_orders");
    expect(calls).toContainEqual(["in", "status", ["submitted", "pending_approval"]]);
    expect(calls).toContainEqual(["gte", "created_at", "2026-09-30T21:00:00.000Z"]);
    expect(calls).toContainEqual(["lt", "created_at", "2026-10-31T22:00:00.000Z"]);
  });

  it("invoices: the overdue rules of the invoices page, plus customer", async () => {
    const customer = "11111111-2222-3333-4444-555555555555";
    const { response, mock } = run("invoices", `?status=overdue&customer=${customer}`, ctx({ "finance.invoice.read": "own", "finance.invoice.export": "own" }), () => []);
    await body(await response);
    const calls = callsOf(mock, "v_invoices");
    expect(calls).toEqual(
      expect.arrayContaining([
        ["in", "status", ["issued", "partially_paid"]],
        ["eq", "is_overdue", true],
        ["gt", "open_amount", 0],
        ["eq", "customer_id", customer],
      ]),
    );
  });

  it("visits: an own-scope user asking for everyone still gets their own visits", async () => {
    const user = ctx({ "field.visit.read": "own", "field.visit.export": "own" });
    const { response, mock } = run("visits", "?who=all", user, () => []);
    await body(await response);
    expect(callsOf(mock, "v_visits")).toContainEqual(["eq", "employee_id", user.employee?.id]);
    const { response: r2, mock: m2 } = run("visits", "?who=all", ctx({ "field.visit.read": "team", "field.visit.export": "team" }), () => []);
    await body(await r2);
    expect(callsOf(m2, "v_visits").some((c) => c[0] === "eq" && c[1] === "employee_id")).toBe(false);
  });

  it("customers: not archived, the customers page's search", async () => {
    const user = ctx({ "crm.customer.read": "own", "crm.customer.export": "all" });
    const rows = [{ customer_no: "C-TEST-1", display_name: "عيادة تجريبية", phone_primary: "+200000000000", location_verified: true }];
    const { response, mock } = run("customers", "?q=clinic&stage=active", user, () => rows);
    const { lines } = await body(await response);
    const calls = callsOf(mock, "v_customers");
    expect(calls).toContainEqual(["is", "archived_at", null]);
    expect(calls).toContainEqual(["eq", "lifecycle_stage", "active"]);
    expect(calls.some((c) => c[0] === "or" && String(c[1]).includes("display_name.ilike"))).toBe(true);
    // The phone is exported as the view returned it, formula-guarded; booleans in the user's locale.
    expect(lines[1]).toBe("C-TEST-1,عيادة تجريبية,,,,'+200000000000,,,,,نعم");
  });

  it("stock: reps read sellable availability, inventory roles the full view", async () => {
    const { response, mock } = run("stock", "", ctx({ "inventory.stock.read": "all", "inventory.stock.export": "all" }), () => []);
    await body(await response);
    expect(mock.raw.from).toHaveBeenCalledWith("v_stock_available");
    const { response: r2, mock: m2 } = run("stock", "", ctx({ "inventory.stock.read": "all", "inventory.stock.export": "all", "inventory.module.access": "all" }), () => []);
    await body(await r2);
    expect(m2.raw.from).toHaveBeenCalledWith("v_inventory_stock");
  });

  it("tracking: calls the team-day RPC for the requested day and converts units", async () => {
    const rows = [{ employee_no: "E-TEST", full_name_en: "Test Rep", full_name_ar: "مندوب تجريبي", business_date: "2026-10-29", shift_seconds: 3600, distance_m: 12345, flags: ["long_idle", "gap"], on_shift: false }];
    const { response, mock } = run("tracking", "?date=2026-10-29&locale=en", ctx({ "field.tracking.read": "team", "field.tracking.export": "team" }), () => rows);
    const res = await response;
    expect(res.headers.get("content-disposition")).toContain("honest-tracking-2026-10-29.csv");
    const { lines } = await body(res);
    expect(mock.raw.rpc).toHaveBeenCalledWith("tracking_team_day", { p_day: "2026-10-29" });
    expect(lines[1]).toBe("E-TEST,Test Rep,2026-10-29,no,,60,,,,,,,,,12.35,,,long_idle; gap,");
  });

  it("order lines: one row per line, carrying the order's number, status and customer", async () => {
    const os = orders(2);
    const lines = [
      { order_item_id: "l2", order_id: os[1]?.id, line_no: 1, sku: "SKU-B", quantity: 1, line_total: 50 },
      { order_item_id: "l1", order_id: os[0]?.id, line_no: 2, sku: "SKU-A2", quantity: 2, line_total: 20 },
      { order_item_id: "l0", order_id: os[0]?.id, line_no: 1, sku: "SKU-A1", quantity: 3, line_total: 30 },
    ];
    const provider: Provider = (target) => (target === "v_orders" ? os : lines);
    const { response, mock } = run("order_lines", "?locale=en", ctx(SALES), provider);
    const out = await body(await response);
    expect(callsOf(mock, "v_order_lines")).toContainEqual(["in", "order_id", [os[0]?.id, os[1]?.id]]);
    expect(out.lines.slice(1).map((l) => l.split(",").slice(0, 6).join(","))).toEqual([
      "SO-TEST-0,approved,Test Clinic 0,2026-10-29 10:00:00,1,SKU-A1",
      "SO-TEST-0,approved,Test Clinic 0,2026-10-29 10:00:00,2,SKU-A2",
      "SO-TEST-1,approved,Test Clinic 1,2026-10-29 10:00:00,1,SKU-B",
    ]);
  });
});

describe("GET /api/export/[kind]: server-side gate and security log (audit-4 A-L4)", () => {
  const refuse =
    (code: string, message: string): Gate =>
    (fn) =>
      fn === "log_export" ? { data: null, error: { code, message } } : { data: null, error: null };

  it("opens the log before reading any row, with the kind, loggable filters and request id", async () => {
    const user = ctx({ "crm.customer.read": "all", "crm.customer.export": "all" });
    const { response, mock } = run("customers", "?q=Dr%20Ahmed%20%2B201001234567&stage=active", user, () => []);
    await body(await response);
    expect(mock.logs[0]).toEqual({
      fn: "log_export",
      args: { p_kind: "customers", p_filters: { q: "[redacted]", stage: "active" }, p_row_count: null, p_request_id: "req-test" },
    });
    expect(JSON.stringify(mock.logs)).not.toMatch(/Ahmed|201001234567/);
  });

  it("records the final row count against the opened export when the file ends", async () => {
    const { response, mock } = run("orders", "", ctx(SALES), () => orders(3));
    await body(await response);
    expect(mock.logs.map((l) => l.fn)).toEqual(["log_export", "log_export_result"]);
    expect(mock.logs[1]?.args).toEqual({ p_export_id: 101, p_row_count: 3, p_truncated: false, p_failed: false });
  });

  it("reports truncation and failures in the result", async () => {
    const { response, mock } = run("orders", "", ctx(SALES), () => orders(5), 3);
    await body(await response);
    expect(mock.logs[1]?.args).toMatchObject({ p_row_count: 3, p_truncated: true, p_failed: false });

    const all = orders(1500);
    const provider: Provider = (_t, _c, from) => (from === 0 ? all : { error: { code: "57014", message: "canceling statement" } });
    const { response: r2, mock: m2 } = run("orders", "", ctx(SALES), provider);
    await body(await r2);
    expect(m2.logs[1]?.args).toMatchObject({ p_row_count: 1000, p_truncated: false, p_failed: true });
  });

  it("records a cancelled download as not finished", async () => {
    const { response, mock } = run("orders", "", ctx(SALES), () => orders(2500));
    const res = await response;
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    await reader.read(); // header row
    await reader.read(); // first 1,000 rows
    await reader.cancel();
    expect(mock.logs[1]?.args).toMatchObject({ p_row_count: 1000, p_failed: true });
  });

  it("fails closed: no row is read when the database refuses the export", async () => {
    const offline: Gate = () => {
      throw new Error("network down");
    };
    const cases: [Gate, number, string][] = [
      [refuse("42501", "PERMISSION_DENIED: crm.customer.export"), 403, "forbidden"],
      [refuse("42501", "MFA_REQUIRED: sales.order.export needs a session verified with your authenticator app"), 403, "mfa_required"],
      [refuse("P0001", "RATE_LIMITED: at most 20 exports per 10 minutes; try again later"), 429, "rate_limited"],
      [refuse("22023", "VALIDATION: unknown export kind orders"), 400, "export_failed"],
      [refuse("PGRST202", "Could not find the function api.log_export"), 404, "export_failed"],
      [refuse("08006", "connection failure"), 500, "export_failed"],
      [offline, 503, "export_failed"],
    ];
    for (const [gate, status, error] of cases) {
      const { response, mock } = run("orders", "", ctx(SALES), () => orders(3), 50_000, undefined, gate);
      const res = await response;
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error, requestId: "req-test" });
      expect(mock.queries).toHaveLength(0);
      expect(mock.logs).toHaveLength(1);
    }
  });

  it("records a failed result when the first page cannot be read", async () => {
    const { response, mock } = run("orders", "", ctx(SALES), () => ({ error: { code: "XX000", message: "boom" } }));
    expect((await response).status).toBe(500);
    expect(mock.logs[1]).toEqual({ fn: "log_export_result", args: { p_export_id: 101, p_row_count: 0, p_truncated: false, p_failed: true } });
  });

  it("tells a rate-limited user when to retry", async () => {
    const { response } = run("orders", "", ctx(SALES), () => [], 50_000, undefined, refuse("P0001", "RATE_LIMITED: slow down"));
    const res = await response;
    expect(res.headers.get("retry-after")).toBe("600");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("still sends the file when recording the result fails (it is already delivered)", async () => {
    const gate: Gate = (fn) => (fn === "log_export" ? { data: 7, error: null } : { data: null, error: { code: "P0002", message: "NOT_FOUND: export 7" } });
    const { response, mock } = run("orders", "", ctx(SALES), () => orders(2), 50_000, undefined, gate);
    const { lines } = await body(await response);
    expect(lines).toHaveLength(3);
    expect(mock.logs[1]?.args).toMatchObject({ p_export_id: 7, p_row_count: 2 });
  });
});
