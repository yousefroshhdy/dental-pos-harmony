"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { z } from "zod";
import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import { findCustomerByNo, findVariantBySku } from "./queries";
import {
  assignCustomerSchema,
  endAssignmentSchema,
  endPromotionSchema,
  formToObject,
  invalidFieldsOf,
  priceItemSchema,
  priceListSchema,
  productSchema,
  productStatusSchema,
  promotionSchema,
  removePriceItemSchema,
  variantSchema,
  variantStatusSchema,
} from "./schemas";
import type { ActionResult, ActionState } from "./types";

/**
 * Catalogue mutations. Each action validates FormData, calls exactly one api.*
 * command as the signed-in user (callCommand) and refreshes the catalogue pages.
 * Authorization is NOT decided here: the database checks catalog.*.manage at
 * scope "all" (and customer scope for customer-specific rows) on every call.
 */

/** Every catalogue page reads the same few views, so refresh the whole section. */
function refresh() {
  revalidatePath("/[locale]/catalog", "layout");
}

const failed = (error: AppError): ActionResult => ({
  ok: false,
  code: error.code,
  messageKey: error.messageKey,
  requestId: error.requestId,
});

function invalid(error: z.ZodError, code = "VALIDATION"): ActionResult {
  const fields = invalidFieldsOf(error);
  return { ok: false, code: fields.includes("attributes") ? "ATTRIBUTES_INVALID" : code, messageKey: "VALIDATION", fields };
}

const notFound = (code: "SKU_NOT_FOUND" | "CUSTOMER_NOT_FOUND"): ActionResult => ({ ok: false, code, messageKey: "NOT_FOUND" });

async function command(name: string, args: Record<string, unknown>): Promise<ActionResult> {
  const result = await callCommand(name, args);
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Products and variants
// ---------------------------------------------------------------------------

export async function saveProduct(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = productSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const p = parsed.data;
  const result = await command("upsert_product", {
    p_product_id: p.product_id,
    p_brand_id: p.brand_id,
    p_category_id: p.category_id,
    p_code: p.code,
    p_name_en: p.name_en,
    p_name_ar: p.name_ar ?? null,
    p_description: p.description ?? null,
    p_is_lot_tracked: p.is_lot_tracked,
    p_is_expiry_tracked: p.is_expiry_tracked,
    p_is_serial_tracked: p.is_serial_tracked,
    p_status: p.mode === "create" ? (p.status ?? "active") : null,
  });
  if (result.ok && p.mode === "create") redirect(`/${p.locale}/catalog/products/${p.product_id}`);
  return result;
}

export async function setProductStatus(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = productStatusSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return command("set_product_status", { p_product_id: parsed.data.product_id, p_status: parsed.data.status });
}

export async function saveVariant(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = variantSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const v = parsed.data;
  return command("upsert_variant", {
    p_variant_id: v.variant_id,
    p_product_id: v.product_id,
    p_sku: v.sku,
    p_name_en: v.name_en,
    p_attributes: v.attributes,
    p_barcode: v.barcode ?? null,
    p_uom: v.uom,
    p_reorder_point: v.reorder_point,
  });
}

export async function setVariantStatus(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = variantStatusSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return command("set_variant_status", { p_variant_id: parsed.data.variant_id, p_status: parsed.data.status });
}

// ---------------------------------------------------------------------------
// Price lists
// ---------------------------------------------------------------------------

export async function savePriceList(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = priceListSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const l = parsed.data;
  const result = await command("upsert_price_list", {
    p_price_list_id: l.price_list_id,
    p_code: l.code,
    p_name: l.name,
    p_kind: l.kind,
    p_priority: l.priority,
    p_valid_from: l.valid_from,
    p_valid_to: l.valid_to ?? null,
    p_is_active: l.is_active,
  });
  if (result.ok && l.mode === "create") redirect(`/${l.locale}/catalog/price-lists/${l.price_list_id}`);
  return result;
}

/** The admin types the EGP price; it is master data, re-validated (> 0, 2 decimals) by the command. */
export async function setPriceItem(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = priceItemSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const i = parsed.data;
  let variantId = i.variant_id;
  if (!variantId && i.sku) {
    const found = await findVariantBySku(i.sku);
    if (!found.ok) return failed(found.error);
    if (!found.data) return notFound("SKU_NOT_FOUND");
    variantId = found.data.id;
  }
  return command("set_price_list_item", {
    p_price_list_id: i.price_list_id,
    p_variant_id: variantId,
    // A decimal string, so no binary floating point touches the price.
    p_unit_price: i.unit_price,
    p_min_qty: i.min_qty,
  });
}

export async function removePriceItem(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = removePriceItemSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const i = parsed.data;
  return command("remove_price_list_item", { p_price_list_id: i.price_list_id, p_variant_id: i.variant_id, p_min_qty: i.min_qty });
}

export async function assignCustomerPriceList(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = assignCustomerSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const a = parsed.data;
  const customer = await findCustomerByNo(a.customer_no);
  if (!customer.ok) return failed(customer.error);
  if (!customer.data) return notFound("CUSTOMER_NOT_FOUND");
  return command("assign_customer_price_list", {
    p_customer_id: customer.data.id,
    p_price_list_id: a.price_list_id,
    p_valid_from: a.valid_from,
    p_valid_to: a.valid_to ?? null,
  });
}

export async function endCustomerPriceList(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = endAssignmentSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const e = parsed.data;
  return command("end_customer_price_list", {
    p_customer_id: e.customer_id,
    p_price_list_id: e.price_list_id,
    p_valid_from: e.valid_from,
    ...(e.end_on ? { p_end_on: e.end_on } : {}),
  });
}

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

export async function createPromotion(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = promotionSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const p = parsed.data;
  let variantId: string | null = null;
  if (p.sku) {
    const found = await findVariantBySku(p.sku);
    if (!found.ok) return failed(found.error);
    if (!found.data) return notFound("SKU_NOT_FOUND");
    variantId = found.data.id;
  }
  let customerId: string | null = null;
  if (p.customer_no) {
    const found = await findCustomerByNo(p.customer_no);
    if (!found.ok) return failed(found.error);
    if (!found.data) return notFound("CUSTOMER_NOT_FOUND");
    customerId = found.data.id;
  }
  return command("create_promotion", {
    p_promotion_id: p.promotion_id,
    p_name: p.name,
    p_discount_pct: p.discount_pct,
    p_valid_from: p.valid_from,
    p_valid_to: p.valid_to ?? null,
    p_brand_id: p.brand_id ?? null,
    p_category_id: p.category_id ?? null,
    p_variant_id: variantId,
    p_customer_id: customerId,
    p_min_qty: p.min_qty,
    p_priority: p.priority,
  });
}

export async function endPromotion(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = endPromotionSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return command("end_promotion", { p_promotion_id: parsed.data.promotion_id });
}
