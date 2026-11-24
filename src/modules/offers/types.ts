import type { OrderErrorCode } from "@/modules/orders/logic";

/**
 * Row shapes of the offer views (migration 20261125000200):
 *   api.v_offers, api.v_offer_items, api.v_offer_customers.
 * numeric(14,2) columns may arrive from PostgREST as a number or a string.
 */
type Numeric = number | string;

export type PricingMode = "package" | "per_line";

export interface OfferRow {
  id: string;
  code: string;
  name_en: string;
  name_ar: string | null;
  description: string | null;
  pricing_mode: PricingMode;
  package_price: Numeric | null;
  valid_from: string;
  valid_to: string | null;
  target_tags: string[];
  is_active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  is_current: boolean;
  paid_items: number;
  bonus_items: number;
  target_customer_count: number;
  is_targeted: boolean;
}

export interface OfferItemRow {
  id: string;
  offer_id: string;
  offer_code: string;
  line_no: number;
  variant_id: string;
  sku: string;
  variant_name: string;
  product_name_en: string;
  product_name_ar: string | null;
  quantity: number;
  is_bonus: boolean;
  net_unit_price: Numeric | null;
}

export interface OfferCustomerRow {
  offer_id: string;
  customer_id: string;
  customer_no: string | null;
  customer_name: string | null;
}

/** One item row of the offer form, as typed. */
export interface OfferItemDraft {
  variant_id: string;
  sku: string;
  name: string;
  quantity: string;
  is_bonus: boolean;
  net_unit_price: string;
}

/** Codes with a message under orders.offerAdmin.errors.* (falls back to orders.errors.*). */
export type OfferErrorCode = OrderErrorCode | "DUPLICATE_CODE" | "CUSTOMER_NOT_FOUND" | "OWNER_ONLY";

export type OfferActionResult = { ok: true; offerId?: string; version?: number } | { ok: false; errorCode: OfferErrorCode; requestId?: string; detail?: string };
export type OfferActionState = OfferActionResult | null;
