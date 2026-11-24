import type { ListSpec } from "@/modules/orders/kit/paging";

/**
 * Server-paginated inventory lists: sortable column ids → api view columns, the
 * default order and the searched columns (orders/kit/paging.ts).
 */
export const STOCK_LIST: ListSpec = {
  pageSize: 50,
  sortColumns: {
    product: "product_name",
    sku: "sku",
    warehouse: "warehouse_code",
    onHand: "on_hand",
    reserved: "reserved",
    available: "available",
    sellable: "sellable_available",
    expiry: "earliest_expiry",
  },
  defaultSort: { id: "product", desc: false },
  searchColumns: ["sku", "product_name", "variant_name", "brand_name"],
};

export const AVAILABLE_LIST: ListSpec = {
  pageSize: 50,
  sortColumns: { product: "product_name", sku: "sku", warehouse: "warehouse_code", available: "available" },
  defaultSort: { id: "product", desc: false },
  searchColumns: ["sku", "product_name", "variant_name"],
};

export const MOVEMENT_LIST: ListSpec = {
  pageSize: 50,
  sortColumns: { when: "created_at", type: "movement_type", warehouse: "warehouse_code", sku: "sku", quantity: "quantity" },
  defaultSort: { id: "when", desc: true },
  searchColumns: ["sku", "lot_no", "reason_code"],
};

export const RECEIPT_LIST: ListSpec = {
  pageSize: 25,
  sortColumns: { number: "receipt_no", supplier: "supplier", warehouse: "warehouse_code", status: "status", received: "received_at", units: "total_quantity" },
  defaultSort: { id: "received", desc: true },
  searchColumns: ["receipt_no", "supplier", "shipment_ref"],
};

export const TRANSFER_LIST: ListSpec = {
  pageSize: 25,
  sortColumns: { number: "transfer_no", from: "from_warehouse_code", to: "to_warehouse_code", status: "status", created: "created_at" },
  defaultSort: { id: "created", desc: true },
  searchColumns: ["transfer_no"],
};
