import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Shared bits of the local screenshot run (docs/TESTING.md "Local signed-in stack").
 * The stack (scripts/e2e-local/up.sh) must be running; it writes .cache/e2e-local/env.local.
 */
export const CACHE_DIR = path.resolve(".cache/e2e-local");
export const STATE_DIR = path.join(CACHE_DIR, "state");
export const IDS_FILE = path.join(CACHE_DIR, "ids.json");
export const SHOTS_DIR = path.resolve(
  process.env.SHOTS_DIR ?? "/tmp/claude-0/-home-user-dental-pos-harmony/afcd60fd-9ea5-52d5-b49b-ee9b24bc1358/scratchpad/shots",
);
export const RESULTS_DIR = path.join(SHOTS_DIR, ".results");

export function localEnv(): Record<string, string> {
  const file = path.join(CACHE_DIR, "env.local");
  if (!existsSync(file)) throw new Error("local stack env not found: run `pnpm e2e:local:up` first");
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** Fixture users (supabase/seed.sql) by persona. The owner signs in at aal2 (mock auth). */
export const PERSONAS = {
  owner: "owner@honest.test",
  sd: "sd@honest.test",
  am: "am.cairo@honest.test",
  rep: "rep.cairo@honest.test",
  finance: "finance@honest.test",
  inventory: "inventory@honest.test",
  admin: "admin@honest.test",
  /** A collection officer who also works the field for visits (demo seed §11, owner decision 2026-11-28). */
  collector: "collector@honest.test",
} as const;
export type Persona = keyof typeof PERSONAS;

export type Ids = Record<string, string>;

/** Ids of demo records (scripts/e2e-local/demo-seed.sql) the screens link to, read once from the database. */
export function queryIds(): Ids {
  const sql = `
    select json_build_object(
      'customer',        (select id from crm.customers where clinic_name = 'Clinic Demo 3'),
      'customerNoPhone', (select id from crm.customers where clinic_name = 'Clinic Demo 6'),
      'orderInvoiced',   'd1000000-0000-0000-0000-000000000001',
      'orderPending',    'd1000000-0000-0000-0000-000000000007',
      'orderDraft',      'd1000000-0000-0000-0000-000000000008',
      'visitDone',       (select v.id from field.visits v join crm.customers c on c.id = v.customer_id
                           where c.clinic_name = 'Clinic Demo 3' and v.status = 'completed' limit 1),
      'visitOpen',       (select v.id from field.visits v join crm.customers c on c.id = v.customer_id
                           where c.clinic_name = 'Clinic Demo 4' and v.status = 'in_progress' limit 1),
      'lead',            (select id from crm.leads where place_id = 'ChIJdemoLeadCairo0002'),
      'approval',        (select r.id from wf.approval_requests r where r.entity_id = 'd1000000-0000-0000-0000-000000000007'),
      'plan',            (select id from perf.commission_plans where code = 'STD-2026'),
      'invoice',         (select id from finance.invoices where order_id = 'd1000000-0000-0000-0000-000000000001'),
      'payment',         (select id from finance.payments where client_ref = 'e1000000-0000-0000-0000-000000000001'),
      'receipt',         (select id from inventory.goods_receipts where shipment_ref = 'SHP-DEMO-001'),
      'variant',         '53000000-0000-0000-0000-000000000001',
      'returnId',        (select id from sales.returns limit 1),
      'offer',           '56000000-0000-0000-0000-0000000000d1',
      'priceList',       '54000000-0000-0000-0000-000000000001',
      'product',         '52000000-0000-0000-0000-000000000001',
      'employee',        '20000000-0000-0000-0000-000000000004',
      'user',            '00000000-0000-0000-0000-0000000000a4',
      'role',            (select id from authz.roles where code = 'sales_rep'),
      'workflow',        (select id from wf.workflow_definitions where code = 'sales.order.discount'),
      'today',           core.business_date()
    )`;
  const out = execFileSync("psql", ["-X", "-At", "-d", process.env.E2E_LOCAL_DB ?? "honest_e2e_local", "-c", sql], {
    env: {
      ...process.env,
      PGHOST: process.env.PGHOST ?? "/var/tmp/honestpg",
      PGPORT: process.env.PGPORT ?? "54329",
      PGUSER: process.env.PGUSER ?? "postgres",
    },
    encoding: "utf8",
  });
  return JSON.parse(out.trim()) as Ids;
}

export function readIds(): Ids {
  return JSON.parse(readFileSync(IDS_FILE, "utf8")) as Ids;
}

export type ShotResult = {
  file: string;
  nn: string;
  screen: string;
  persona: Persona;
  locale: string;
  width: number;
  url: string;
  status: number | null;
  hScroll: { scrollWidth: number; innerWidth: number } | null;
  sidebarShort?: boolean;
  smallTargets: string[];
  untranslated: string[];
  consoleErrors: string[];
  failedRequests: string[];
  alerts: string[];
  errorBoundary: boolean;
  notFound: boolean;
};
