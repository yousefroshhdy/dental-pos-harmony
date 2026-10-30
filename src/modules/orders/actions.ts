"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import type { SendResult } from "@/lib/offline/types";
import { CATALOG_MAX_VARIANTS } from "./device-store";
import { orderErrorCode } from "./logic";
import { toDraftSendResult, type DraftPayload } from "./offline-logic";
import { listSellableCatalog, searchSellableVariants } from "./queries";
import {
  draftPayloadSchema,
  formToObject,
  fulfilSchema,
  orderReasonSchema,
  orderRefSchema,
  reserveSchema,
  searchSchema,
} from "./schemas";
import type { CatalogSnapshotResult, OrderActionResult, OrderActionState, VariantSearchResult } from "./types";

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
  const { order_id, customer_id, lines, notes, visit_id, version } = parsed.data;
  const result = await callCommand("save_order_draft", {
    p_order_id: order_id,
    p_customer_id: customer_id,
    // Exactly the two keys the client may send per line (see draftLineSchema).
    p_lines: lines.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity })),
    p_notes: notes || null,
    p_visit_id: visit_id,
    p_version: version,
  });
  if (result.ok) refresh();
  return toDraftSendResult(result);
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
