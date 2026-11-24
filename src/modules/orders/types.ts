import type { OrderErrorCode } from "./logic";
import type { CatalogSnapshot } from "./offline-logic";

/**
 * Row shapes of the views the orders UI reads:
 *   api.v_orders, api.v_order_lines, api.v_stock_available (…_orders_inventory_workflow.sql)
 *   api.v_sellable_variants, api.v_order_status_history (…20261030000300_orders_ui_views.sql)
 *   api.v_customers (…_crm_field_commands.sql)
 * numeric(14,2) columns may arrive from PostgREST as a number or a string.
 */

export const ORDER_STATUSES = [
  "draft",
  "submitted",
  "pending_approval",
  "approved",
  "rejected",
  "reserved",
  "partially_fulfilled",
  "fulfilled",
  "invoiced",
  "closed",
  "cancelled",
  "returned",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

type Numeric = number | string;

export interface OrderRow {
  id: string;
  order_no: string | null;
  customer_id: string;
  customer_name: string | null;
  employee_id: string;
  employee_name: string | null;
  territory_id: string | null;
  visit_id: string | null;
  status: OrderStatus;
  currency: string;
  payment_terms_days: number;
  subtotal: Numeric;
  discount_total: Numeric;
  tax_total: Numeric;
  total: Numeric;
  notes: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  pending_approval_request_id: string | null;
  /** Invoice-level discount the seller asked for (one of the two, or neither). */
  invoice_discount_amount?: Numeric | null;
  invoice_discount_pct?: Numeric | null;
}

export interface OrderLineRow {
  order_item_id: string;
  order_id: string;
  line_no: number;
  variant_id: string;
  sku: string | null;
  variant_name: string | null;
  quantity: number;
  list_price: Numeric;
  applied_discount_pct: Numeric;
  tax_rate_pct: Numeric;
  line_subtotal: Numeric;
  line_discount: Numeric;
  line_tax: Numeric;
  line_total: Numeric;
  fulfilled_qty: number;
  reserved_qty: number;
  /** Free item (price 0): from an offer, or manual with sales-manager approval. */
  is_bonus?: boolean;
  offer_id?: string | null;
  offer_code?: string | null;
  offer_packages?: number | null;
  /** The net unit price the seller typed (before VAT), if any. */
  requested_net_price?: Numeric | null;
  requested_discount_pct?: Numeric;
  /** This line's share of the invoice-level discount (part of line_discount). */
  invoice_discount_share?: Numeric;
  manual_discount_pct?: Numeric;
}

export interface OrderHistoryRow {
  id: number;
  order_id: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  changed_at: string;
  reason: string | null;
  is_mine: boolean | null;
  changed_by_name_en: string | null;
  changed_by_name_ar: string | null;
}

export interface SellableVariant {
  variant_id: string;
  sku: string;
  variant_name: string;
  uom: string;
  product_code: string;
  product_name_en: string;
  product_name_ar: string | null;
  brand_name: string | null;
}

export interface CustomerOption {
  id: string;
  customer_no: string | null;
  display_name: string;
}

export interface StockAvailableRow {
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  variant_id: string;
  available: number;
}

/**
 * How the seller asks for a line's price: the list price, a discount %, or a
 * net unit price (before VAT). The text is kept as typed; the server converts a
 * net price into the discount and checks it against the limits.
 */
export type PriceAdjust = { kind: "discount" | "net"; value: string } | null;

/** A line in the builder: only what the client is allowed to send, plus display text. */
export interface BuilderLine {
  variant_id: string;
  quantity: number;
  sku: string;
  name: string;
  /** Free item outside an offer (a sales manager approves it at submit). */
  bonus?: boolean;
  adjust?: PriceAdjust;
}

/** An offer picked in the builder; the server expands it into its items. */
export interface BuilderOffer {
  offer_id: string;
  /** Number of packages (every item quantity is multiplied by it). */
  packages: number;
  code: string;
  name: string;
}

/** Invoice-level discount as typed: an amount in EGP or a percentage of the order net. */
export type InvoiceDiscountInput = { kind: "amount" | "pct"; value: string } | null;

/** One offer the seller may pick for the selected customer (api.eligible_offers). */
export interface OfferOption {
  offer_id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  description: string | null;
  pricing_mode: "package" | "per_line";
  package_price: Numeric | null;
  valid_from: string;
  valid_to: string | null;
  version: number;
  items: {
    line_no: number;
    variant_id: string;
    sku: string;
    variant_name: string;
    quantity: number;
    is_bonus: boolean;
    net_unit_price: Numeric | null;
  }[];
}

/** One priced line of api.preview_order. */
export interface PreviewLine {
  line_no: number;
  variant_id: string;
  sku: string;
  variant_name: string;
  quantity: number;
  is_bonus: boolean;
  offer_id: string | null;
  offer_code: string | null;
  list_price: Numeric;
  requested_net_price: Numeric | null;
  applied_discount_pct: Numeric;
  manual_discount_pct: Numeric;
  line_subtotal: Numeric;
  line_discount: Numeric;
  invoice_discount_share: Numeric;
  tax_rate_pct: Numeric;
  line_tax: Numeric;
  line_total: Numeric;
}

export interface VatGroupRow {
  rate: Numeric;
  taxable: Numeric;
  vat: Numeric;
}

/** api.preview_order: the server's pricing of the builder, nothing saved. */
export interface OrderPreview {
  subtotal: Numeric;
  discount_total: Numeric;
  tax_total: Numeric;
  total: Numeric;
  prices_include_vat: boolean;
  invoice_discount_total: Numeric;
  lines: PreviewLine[];
  vat_groups: VatGroupRow[];
  approval: { needed: boolean; reasons: string[]; owner_required: boolean; mode: string };
}

export type PreviewResult = { ok: true; preview: OrderPreview } | { ok: false; errorCode: OrderErrorCode; requestId?: string };
export type OffersResult = { ok: true; offers: OfferOption[] } | { ok: false; errorCode: OrderErrorCode; requestId?: string };
/** What the builder needs about a saved draft beyond its lines (its offers and invoice discount). */
export type DraftPricingResult =
  | { ok: true; offers: BuilderOffer[]; invoiceDiscount: InvoiceDiscountInput }
  | { ok: false; errorCode: OrderErrorCode; requestId?: string };

/** Result of an orders Server Action. Only a translatable code and a request id reach the browser. */
export type OrderActionResult =
  | { ok: true; cancelRequested?: boolean }
  | { ok: false; errorCode: OrderErrorCode; requestId?: string };
/** `null` = the form has not been submitted yet (useActionState initial state). */
export type OrderActionState = OrderActionResult | null;

export type CatalogSnapshotResult =
  | { ok: true; snapshot: CatalogSnapshot }
  | { ok: false; errorCode: OrderErrorCode; requestId?: string };

export type VariantSearchResult =
  | { ok: true; items: SellableVariant[] }
  | { ok: false; errorCode: OrderErrorCode; requestId?: string };
