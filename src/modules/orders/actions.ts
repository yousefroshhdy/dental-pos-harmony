"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import type { SendResult } from "@/lib/offline/types";
import { CATALOG_MAX_VARIANTS } from "./device-store";
import { invoiceDiscountOf, offersFromLines, orderErrorCode } from "./logic";
import { toCommandLines, toDraftSendResult, type DraftPayload } from "./offline-logic";
import { getOrder, listOrderLines, listSellableCatalog, searchSellableVariants } from "./queries";
import {
  idSchema,
  draftPayloadSchema,
  formToObject,
  fulfilSchema,
  orderReasonSchema,
  orderRefSchema,
  previewSchema,
  reserveSchema,
  searchSchema,
} from "./schemas";
import type {
  CatalogSnapshotResult,
  DraftPricingResult,
  OfferOption,
  OffersResult,
  OrderActionResult,
  OrderActionState,
  OrderPreview,
  PreviewResult,
  VariantSearchResult,
} from "./types";

/**
 * Order mutations. Each action validates FormData, calls exactly one api.*
 * command as the signed-in user and refreshes the order pages. Hidden inputs
 * only identify records; the database decides permission, scope and status,
 * and computes every price, discount, tax and total.
 */

const PAGES = ["/[locale]/orders", "/[locale]/orders/[orderId]", "/[locale]/orders/[orderId]/edit"] as const;

function refresh() {
  for (const page of PAGES) revalidatePath(page, "page");
}

const failed = (error: AppError): OrderActionResult => ({ ok: false, errorCode: orderErrorCode(error), requestId: error.requestId });
const invalid = (field?: string): OrderActionResult => ({ ok: false, errorCode: field === "reason" ? "REASON_REQUIRED" : "VALIDATION" });

const detailPath = (locale: string, orderId: string, flag?: string) => `/${locale}/orders/${orderId}${flag ? `?${flag}=1` : ""}`;

/**
 * Create or replace a draft (api.save_order_draft). The payload was fixed on the
 * device before the first attempt; the same payload is sent directly or replayed
 * from the offline queue (offline.ts), and the command answers a replay of the
 * same (order id, base version) as `replayed` (migration 20261103000300). The
 * answer carries no prices: the order page then reads the server's prices
 * (save-draft-then-read).
 */
export async function saveDraftOnDevice(payload: DraftPayload): Promise<SendResult> {
  const parsed = draftPayloadSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: { code: "VALIDATION", messageKey: "VALIDATION", retryable: false } };
  const { order_id, customer_id, lines, notes, visit_id, version, invoice_discount } = parsed.data;
  const result = await callCommand("save_order_draft", {
    p_order_id: order_id,
    p_customer_id: customer_id,
    // Only the keys the server accepts per line (draftLineSchema / offerLineSchema); the plain
    // array when there is no invoice discount, so earlier queued saves keep their fingerprint.
    p_lines: toCommandLines(lines, invoice_discount),
    p_notes: notes || null,
    p_visit_id: visit_id,
    p_version: version,
  });
  if (result.ok) refresh();
  return toDraftSendResult(result);
}

/**
 * The server's pricing of what is in the builder (api.preview_order): totals, every
 * line, VAT per rate and whether submitting would need approval. Nothing is saved.
 */
export async function previewOrder(input: {
  customer_id: string;
  lines: DraftPayload["lines"];
  invoice_discount?: DraftPayload["invoice_discount"];
}): Promise<PreviewResult> {
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errorCode: "VALIDATION" };
  const result = await callCommand<OrderPreview>("preview_order", {
    p_customer_id: parsed.data.customer_id,
    p_lines: toCommandLines(parsed.data.lines, parsed.data.invoice_discount),
  });
  if (!result.ok) return { ok: false, errorCode: orderErrorCode(result.error), requestId: result.error.requestId };
  return { ok: true, preview: result.data };
}

/** The offers the seller may pick today for this customer (api.eligible_offers). */
export async function loadEligibleOffers(customerId: string): Promise<OffersResult> {
  const parsed = idSchema.safeParse(customerId);
  if (!parsed.success) return { ok: false, errorCode: "VALIDATION" };
  const result = await callCommand<OfferOption[]>("eligible_offers", { p_customer_id: parsed.data });
  if (!result.ok) return { ok: false, errorCode: orderErrorCode(result.error), requestId: result.error.requestId };
  return { ok: true, offers: Array.isArray(result.data) ? result.data : [] };
}

/** A saved draft's offers and invoice discount, for the builder when it edits the draft. */
export async function loadDraftPricing(orderId: string): Promise<DraftPricingResult> {
  const parsed = idSchema.safeParse(orderId);
  if (!parsed.success) return { ok: false, errorCode: "VALIDATION" };
  const [order, lines] = await Promise.all([getOrder(parsed.data), listOrderLines(parsed.data)]);
  if (!order.ok) return { ok: false, errorCode: orderErrorCode(order.error), requestId: order.error.requestId };
  if (!order.data) return { ok: false, errorCode: "NOT_FOUND" };
  if (!lines.ok) return { ok: false, errorCode: orderErrorCode(lines.error), requestId: lines.error.requestId };
  return { ok: true, offers: offersFromLines(lines.data), invoiceDiscount: invoiceDiscountOf(order.data) };
}

/** The sellable-variant list with indicative list prices, for the device cache (offline search). */
export async function loadCatalogSnapshot(): Promise<CatalogSnapshotResult> {
  const result = await listSellableCatalog(CATALOG_MAX_VARIANTS);
  if (!result.ok) return { ok: false, errorCode: orderErrorCode(result.error), requestId: result.error.requestId };
  return { ok: true, snapshot: { at: new Date().toISOString(), ...result.data } };
}

export async function submitOrder(_prev: OrderActionState, form: FormData): Promise<OrderActionResult> {
  const parsed = orderRefSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid();
  const result = await callCommand("submit_order", { p_order_id: parsed.data.order_id });
  if (!result.ok) return failed(result.error);
  refresh();
  // The detail page reads the outcome (status + approval reasons) back from the database.
  redirect(detailPath(parsed.data.locale, parsed.data.order_id, "submitted"));
}

export async function approveOrder(_prev: OrderActionState, form: FormData): Promise<OrderActionResult> {
  const parsed = orderRefSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid();
  const result = await callCommand("approve_order", { p_order_id: parsed.data.order_id });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true };
}

export async function rejectOrder(_prev: OrderActionState, form: FormData): Promise<OrderActionResult> {
  const parsed = orderReasonSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(String(parsed.error.issues[0]?.path[0] ?? ""));
  const result = await callCommand("reject_order", { p_order_id: parsed.data.order_id, p_reason: parsed.data.reason });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true };
}

export async function cancelOrder(_prev: OrderActionState, form: FormData): Promise<OrderActionResult> {
  const parsed = orderReasonSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(String(parsed.error.issues[0]?.path[0] ?? ""));
  const result = await callCommand<{ status?: string; approval_request_id?: string | null }>("cancel_order", {
    p_order_id: parsed.data.order_id,
    p_reason: parsed.data.reason,
  });
  if (!result.ok) return failed(result.error);
  refresh();
  // Approved/reserved orders are not cancelled yet: a 'sales.order.cancel' approval request was raised.
  return { ok: true, cancelRequested: Boolean(result.data?.approval_request_id) };
}

export async function reserveOrder(_prev: OrderActionState, form: FormData): Promise<OrderActionResult> {
  const parsed = reserveSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid();
  const result = await callCommand("reserve_order", { p_order_id: parsed.data.order_id, p_warehouse_id: parsed.data.warehouse_id });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true };
}

export async function fulfilOrder(_prev: OrderActionState, form: FormData): Promise<OrderActionResult> {
  const parsed = fulfilSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid();
  const result = await callCommand("post_fulfillment", {
    p_order_id: parsed.data.order_id,
    p_idempotency_key: parsed.data.idempotency_key,
  });
  if (!result.ok) return failed(result.error);
  refresh();
  return { ok: true };
}

/** Builder catalogue search (read-only; RLS on the catalogue applies). */
export async function searchVariants(query: string): Promise<VariantSearchResult> {
  const parsed = searchSchema.safeParse(query);
  if (!parsed.success) return { ok: false, errorCode: "VALIDATION" };
  const result = await searchSellableVariants(parsed.data);
  if (!result.ok) return { ok: false, errorCode: orderErrorCode(result.error), requestId: result.error.requestId };
  return { ok: true, items: result.data };
}
