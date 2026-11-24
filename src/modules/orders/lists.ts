import type { ListSpec } from "./kit/paging";

/**
 * Server-paginated lists of the orders module: sortable column ids → api view
 * columns, the default order and the searched columns (kit/paging.ts).
 */
export const ORDER_LIST: ListSpec = {
  pageSize: 25,
  sortColumns: { number: "order_no", customer: "customer_name", rep: "employee_name", status: "status", created: "created_at", total: "total" },
  defaultSort: { id: "created", desc: true },
  searchColumns: ["order_no", "customer_name", "employee_name"],
};
