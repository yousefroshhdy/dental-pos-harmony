import "server-only";
import { fail, networkError, ok, parseDbError, type Result } from "@/lib/errors";
import { log } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import type { InvoiceFilter, PaymentFilter, CollectionFilter } from "./logic";
import { COLLECTION_FILTERS, INVOICE_FILTERS, PAYMENT_FILTERS } from "./logic";
import type {
  AgingBucket,
  AgingRow,
  AgingTotalsRow,
  AllocationRow,
  CollectionTaskRow,
  CreditNoteRow,
  CreditRequestRow,
  CustomerOption,
  InvoiceableLineRow,
  InvoiceableOrderRow,
  InvoiceLineRow,
  InvoiceRow,
  PaymentRow,
  StatementRow,
} from "./types";

/**
 * Finance reads. All go through the user's session against api.v_* views
 * (security_invoker), so RLS decides what comes back: reps see their own
 * customers' invoices and payments, finance sees everything.
 */

type Query = PromiseLike<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

async function run<T>(name: string, query: Query, empty: T): Promise<Result<T>> {
  try {
    const { data, error } = await query;
    if (error) {
      const appError = parseDbError(error);
      log("warn", "finance.read_failed", { view: name, code: appError.code, detail: appError.detail });
      return fail(appError);
    }
    return ok((data ?? empty) as T);
  } catch (cause) {
    log("error", "finance.read_failed", { view: name, detail: cause instanceof Error ? cause.message : String(cause) });
    return fail(networkError(cause));
  }
}

export const LIST_LIMIT = 200;

const INVOICE_COLUMNS =
  "id, invoice_no, order_id, order_no, customer_id, customer_no, customer_name, territory_id, rep_employee_id, " +
  "rep_name_en, rep_name_ar, issue_date, due_date, status, currency, subtotal, discount_total, tax_total, total, " +
  "allocated, credited, open_amount, days_overdue, is_overdue, aging_bucket, eta_status, eta_uuid, created_at";
const PAYMENT_COLUMNS =
  "id, payment_no, client_ref, customer_id, customer_no, customer_name, collected_by, collected_by_name_en, " +
  "collected_by_name_ar, method, amount, allocated, unallocated, received_at, reference, cheque_due_date, status, " +
  "status_reason, confirmed_at, reversed_at, created_at, is_mine";
const COLLECTION_COLUMNS =
  "id, customer_id, customer_no, customer_name, invoice_id, invoice_no, invoice_due_date, invoice_open_amount, " +
  "days_overdue, assignee_employee_id, assignee_name_en, assignee_name_ar, due_date, status, promised_amount, " +
  "promised_date, promise_broken, outcome, work_task_id, created_at, updated_at, closed_at, is_mine";
const AGING_COLUMNS =
  "customer_id, customer_no, customer_name, territory_id, territory_code, territory_name_en, territory_name_ar, " +
  "rep_employee_id, rep_name_en, rep_name_ar, current_amount, d1_30, d31_60, d61_90, d90_plus, total_open, " +
  "overdue_amount, open_invoices, overdue_invoices, max_days_overdue, ledger_balance, unapplied_credit";

export interface InvoiceListFilter {
  filter: InvoiceFilter;
  customerId: string | null;
  bucket: AgingBucket | null;
}

export async function listInvoices({ filter, customerId, bucket }: InvoiceListFilter): Promise<Result<InvoiceRow[]>> {
  const db = await createClient();
  let query = db.from("v_invoices").select(INVOICE_COLUMNS);
  const statuses = INVOICE_FILTERS[filter];
  if (statuses.length > 0) query = query.in("status", [...statuses]);
  if (filter === "overdue") query = query.eq("is_overdue", true);
  if (filter === "open" || filter === "overdue") query = query.gt("open_amount", 0);
  if (customerId) query = query.eq("customer_id", customerId);
  if (bucket) query = query.eq("aging_bucket", bucket);
  const ordered = filter === "open" || filter === "overdue" ? query.order("due_date") : query.order("issue_date", { ascending: false });
  return run("v_invoices", ordered.order("invoice_no", { ascending: false }).limit(LIST_LIMIT), []);
}

export async function getInvoice(invoiceId: string): Promise<Result<InvoiceRow | null>> {
  const db = await createClient();
  return run("v_invoices", db.from("v_invoices").select(INVOICE_COLUMNS).eq("id", invoiceId).maybeSingle(), null);
}

export async function listInvoiceLines(invoiceId: string): Promise<Result<InvoiceLineRow[]>> {
  const db = await createClient();
  return run(
    "v_invoice_lines",
    db
      .from("v_invoice_lines")
      .select(
        "invoice_item_id, invoice_id, order_item_id, variant_id, sku, description, quantity, unit_price, line_subtotal, " +
          "discount, tax_rate_pct, tax_amount, line_total, credited_qty, credited_amount",
      )
      .eq("invoice_id", invoiceId)
      .order("sku"),
    [],
  );
}

export async function listCreditNotes(invoiceId: string): Promise<Result<CreditNoteRow[]>> {
  const db = await createClient();
  return run(
    "v_credit_notes",
    db
      .from("v_credit_notes")
      .select("id, credit_no, invoice_id, invoice_no, customer_id, customer_name, reason, amount, tax_amount, total, issue_date, return_id, approval_request_id, created_at, by_lines")
      .eq("invoice_id", invoiceId)
      .order("credit_no"),
    [],
  );
}

/** Credit-note requests for an invoice still waiting for a decision (visible to the requester and approvers). */
export async function listPendingCreditRequests(invoiceId: string): Promise<Result<CreditRequestRow[]>> {
  const db = await createClient();
  return run(
    "v_approval_requests",
    db
      .from("v_approval_requests")
      .select("request_id, status, created_at, payload")
      .eq("workflow_code", "finance.credit_note")
      .eq("status", "pending")
      .eq("payload->>invoice_id", invoiceId)
      .order("created_at"),
    [],
  );
}

const ALLOCATION_COLUMNS =
  "id, payment_id, payment_no, payment_method, invoice_id, invoice_no, amount, reverses_allocation_id, is_reversed, allocated_at, reason";

export async function listAllocationsForInvoice(invoiceId: string): Promise<Result<AllocationRow[]>> {
  const db = await createClient();
  return run("v_payment_allocations", db.from("v_payment_allocations").select(ALLOCATION_COLUMNS).eq("invoice_id", invoiceId).order("allocated_at"), []);
}

export async function listAllocationsForPayment(paymentId: string): Promise<Result<AllocationRow[]>> {
  const db = await createClient();
  return run("v_payment_allocations", db.from("v_payment_allocations").select(ALLOCATION_COLUMNS).eq("payment_id", paymentId).order("allocated_at"), []);
}

/** Open invoices of a customer, oldest due first (allocation candidates). */
export async function listOpenInvoices(customerId: string): Promise<Result<InvoiceRow[]>> {
  const db = await createClient();
  return run(
    "v_invoices",
    db
      .from("v_invoices")
      .select(INVOICE_COLUMNS)
      .eq("customer_id", customerId)
      .in("status", ["issued", "partially_paid"])
      .gt("open_amount", 0)
      .order("due_date")
      .order("issue_date")
      .order("invoice_no")
      .limit(LIST_LIMIT),
    [],
  );
}

export async function listPayments(filter: PaymentFilter, customerId: string | null): Promise<Result<PaymentRow[]>> {
  const db = await createClient();
  let query = db.from("v_payments").select(PAYMENT_COLUMNS);
  const statuses = PAYMENT_FILTERS[filter];
  if (statuses.length > 0) query = query.in("status", [...statuses]);
  if (filter === "unallocated") query = query.gt("unallocated", 0);
  if (customerId) query = query.eq("customer_id", customerId);
  return run("v_payments", query.order("received_at", { ascending: false }).limit(LIST_LIMIT), []);
}

export async function getPayment(paymentId: string): Promise<Result<PaymentRow | null>> {
  const db = await createClient();
  return run("v_payments", db.from("v_payments").select(PAYMENT_COLUMNS).eq("id", paymentId).maybeSingle(), null);
}

export const STATEMENT_LIMIT = 2000;

/** The latest STATEMENT_LIMIT ledger rows of one customer, oldest first (running balance computed by the view). */
export async function listStatement(customerId: string): Promise<Result<StatementRow[]>> {
  const db = await createClient();
  const result = await run<StatementRow[]>(
    "v_customer_statement",
    db
      .from("v_customer_statement")
      .select(
        "entry_id, customer_id, customer_no, customer_name, posted_at, posted_date, entry_type, source_table, source_id, " +
          "document_no, due_date, debit, credit, amount, running_balance",
      )
      .eq("customer_id", customerId)
      .order("posted_at", { ascending: false })
      .order("entry_id", { ascending: false })
      .limit(STATEMENT_LIMIT),
    [],
  );
  return result.ok ? ok([...result.data].reverse()) : result;
}

export async function getCustomer(customerId: string): Promise<Result<CustomerOption | null>> {
  const db = await createClient();
  return run("v_customers", db.from("v_customers").select("id, customer_no, display_name").eq("id", customerId).maybeSingle(), null);
}

export const CUSTOMER_LIMIT = 500;

/** Customers the user can see (crm.customer.read scope), for payment and filter pickers. */
export async function listCustomers(): Promise<Result<CustomerOption[]>> {
  const db = await createClient();
  return run(
    "v_customers",
    db.from("v_customers").select("id, customer_no, display_name").is("archived_at", null).order("display_name").limit(CUSTOMER_LIMIT),
    [],
  );
}

export async function listAging(): Promise<Result<AgingRow[]>> {
  const db = await createClient();
  return run("v_ar_aging", db.from("v_ar_aging").select(AGING_COLUMNS).order("overdue_amount", { ascending: false }).limit(1000), []);
}

export async function getAgingTotals(): Promise<Result<AgingTotalsRow | null>> {
  const db = await createClient();
  return run(
    "v_ar_aging_totals",
    db
      .from("v_ar_aging_totals")
      .select("customers, current_amount, d1_30, d31_60, d61_90, d90_plus, total_open, overdue_amount, ledger_balance, unapplied_credit")
      .maybeSingle(),
    null,
  );
}

export async function listCollectionTasks(filter: CollectionFilter): Promise<Result<CollectionTaskRow[]>> {
  const db = await createClient();
  let query = db.from("v_collection_tasks").select(COLLECTION_COLUMNS);
  const statuses = COLLECTION_FILTERS[filter];
  if (statuses.length > 0) query = query.in("status", [...statuses]);
  return run("v_collection_tasks", query.order("due_date").order("days_overdue", { ascending: false }).limit(LIST_LIMIT), []);
}

export async function listInvoiceableOrders(): Promise<Result<InvoiceableOrderRow[]>> {
  const db = await createClient();
  return run(
    "v_invoiceable_orders",
    db
      .from("v_invoiceable_orders")
      .select(
        "order_id, order_no, customer_id, customer_name, status, employee_id, employee_name_en, employee_name_ar, " +
          "payment_terms_days, order_total, submitted_at, uninvoiced_qty, uninvoiced_lines, invoices",
      )
      .order("submitted_at")
      .limit(LIST_LIMIT),
    [],
  );
}

export async function getInvoiceableOrder(orderId: string): Promise<Result<InvoiceableOrderRow | null>> {
  const db = await createClient();
  return run(
    "v_invoiceable_orders",
    db
      .from("v_invoiceable_orders")
      .select(
        "order_id, order_no, customer_id, customer_name, status, employee_id, employee_name_en, employee_name_ar, " +
          "payment_terms_days, order_total, submitted_at, uninvoiced_qty, uninvoiced_lines, invoices",
      )
      .eq("order_id", orderId)
      .maybeSingle(),
    null,
  );
}

export async function listInvoiceableLines(orderId: string): Promise<Result<InvoiceableLineRow[]>> {
  const db = await createClient();
  return run(
    "v_invoiceable_order_lines",
    db
      .from("v_invoiceable_order_lines")
      .select(
        "order_item_id, order_id, line_no, variant_id, sku, variant_name, quantity, fulfilled_qty, invoiced_qty, uninvoiced_qty, " +
          "list_price, applied_discount_pct, tax_rate_pct",
      )
      .eq("order_id", orderId)
      .order("line_no"),
    [],
  );
}

/** Invoices already issued for an order (to show after issuing, or when nothing is left to invoice). */
export async function listInvoicesForOrder(orderId: string): Promise<Result<InvoiceRow[]>> {
  const db = await createClient();
  return run("v_invoices", db.from("v_invoices").select(INVOICE_COLUMNS).eq("order_id", orderId).order("invoice_no"), []);
}
