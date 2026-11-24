import type { ListSpec } from "@/modules/orders/kit/paging";
import type { InvoiceFilter } from "./logic";

/**
 * Server-paginated finance lists: sortable column ids → api view columns, the
 * default order and the searched columns (orders/kit/paging.ts). The open and
 * overdue invoice lists keep their "oldest due first" order; the others newest first.
 */
const INVOICE_SORT = {
  number: "invoice_no",
  customer: "customer_name",
  issued: "issue_date",
  due: "due_date",
  total: "total",
  open: "open_amount",
} as const;

export function invoiceList(filter: InvoiceFilter): ListSpec {
  return {
    pageSize: 25,
    sortColumns: INVOICE_SORT,
    defaultSort: filter === "open" || filter === "overdue" ? { id: "due", desc: false } : { id: "issued", desc: true },
    searchColumns: ["invoice_no", "customer_name", "customer_no", "order_no"],
  };
}

export const PAYMENT_LIST: ListSpec = {
  pageSize: 25,
  sortColumns: { number: "payment_no", customer: "customer_name", received: "received_at", amount: "amount", unallocated: "unallocated" },
  defaultSort: { id: "received", desc: true },
  searchColumns: ["payment_no", "customer_name", "customer_no", "reference"],
};

export const AGING_LIST: ListSpec = {
  pageSize: 50,
  sortColumns: {
    customer: "customer_name",
    current: "current_amount",
    d1_30: "d1_30",
    d31_60: "d31_60",
    d61_90: "d61_90",
    d90_plus: "d90_plus",
    total: "total_open",
    overdue: "overdue_amount",
  },
  defaultSort: { id: "overdue", desc: true },
  searchColumns: ["customer_name", "customer_no"],
};
