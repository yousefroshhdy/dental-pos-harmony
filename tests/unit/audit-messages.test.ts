import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_ERROR_CODES } from "@/modules/audit/logic";
import { auditNav } from "@/modules/audit/nav";
import { AUDIT_ACTIONS, MASK_CATEGORIES } from "@/modules/audit/types";

type Tree = Record<string, unknown>;
const load = (locale: string) => JSON.parse(readFileSync(join(__dirname, `../../messages/${locale}/audit.json`), "utf8")) as Tree;
const at = (tree: Tree, path: string) => path.split(".").reduce<unknown>((n, k) => (n as Tree | undefined)?.[k], tree);

// Tables carrying the audit trigger at 20261103001100 (api.audit_tables lists them live;
// unknown tables fall back to schema.table, so this list only guards the labels we ship).
const AUDITED_TABLES = [
  "authz.role_permissions", "authz.roles", "authz.user_permission_overrides", "authz.user_roles",
  "catalog.customer_price_lists", "catalog.price_list_items", "catalog.price_lists", "catalog.product_costs",
  "catalog.product_variants", "catalog.products",
  "core.employees", "core.system_settings", "core.territories", "core.user_profiles",
  "crm.customer_assignments", "crm.customer_contacts", "crm.customers", "crm.opportunities",
  "field.tracking_notice_acks", "field.tracking_notices", "field.visits",
  "finance.collection_tasks", "finance.credit_notes", "finance.invoices", "finance.payments",
  "integration.routes", "inventory.transfers", "inventory.warehouses",
  "perf.commission_adjustments", "perf.commission_periods", "perf.commission_plan_rules", "perf.commission_plans",
  "perf.kpi_definitions", "perf.kpi_targets",
  "sales.discount_rules", "sales.order_items", "sales.orders",
  "wf.approval_requests", "wf.workflow_definitions", "wf.workflow_rules", "wf.workflow_stages",
  "work.tasks",
];

describe.each(["ar", "en"])("audit messages (%s)", (locale) => {
  const messages = load(locale);

  it("translate every action, mask category, error and nav entry", () => {
    for (const a of AUDIT_ACTIONS) expect(at(messages, `actions.${a}`), a).toEqual(expect.any(String));
    for (const c of [...MASK_CATEGORIES, "other"]) expect(at(messages, `categories.${c}`), c).toEqual(expect.any(String));
    for (const k of ["added", "removed", "changed"]) expect(at(messages, `kinds.${k}`), k).toEqual(expect.any(String));
    for (const e of AUDIT_ERROR_CODES) expect(at(messages, `errors.${e}`), e).toEqual(expect.any(String));
    for (const item of auditNav) expect(at(messages, item.labelKey.replace(/^audit\./, "")), item.labelKey).toEqual(expect.any(String));
  });

  it("translate every invalid-filter notice", () => {
    for (const f of ["table", "record", "actor", "from", "to", "action", "before", "range"]) {
      expect(at(messages, `invalid.${f}`), f).toEqual(expect.any(String));
    }
  });

  it("label every audited table", () => {
    for (const ref of AUDITED_TABLES) expect(at(messages, `tables.${ref}`), ref).toEqual(expect.any(String));
  });

  it("carry the placeholders the pages pass", () => {
    expect(at(messages, "errors.UNKNOWN")).toContain("{requestId}");
    expect(at(messages, "entry.masked")).toContain("{category}");
    expect(at(messages, "entry.by")).toContain("{name}");
    expect(at(messages, "entry.changes")).toContain("count");
  });
});

describe("audit nav", () => {
  it("is gated on the row-image permission and lives in the audit namespace", () => {
    expect(auditNav).toEqual([{ href: "/audit", labelKey: "audit.nav.log", permission: "audit.row_image.read" }]);
  });
});
