import type { ListSpec } from "@/modules/orders/kit/paging";

/** The returns list, server-paginated (orders/kit/paging.ts): newest first by default. */
export const RETURN_LIST: ListSpec = {
  pageSize: 25,
  sortColumns: { number: "return_no", customer: "customer_name", order: "order_no", status: "status", created: "created_at", units: "total_qty" },
  defaultSort: { id: "created", desc: true },
  searchColumns: ["return_no", "customer_name", "customer_no", "order_no"],
};
