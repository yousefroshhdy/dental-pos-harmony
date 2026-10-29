"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { z } from "zod";
import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import { composeReason, parseAdjustmentResult, signedQuantity } from "./logic";
import {
  adjustmentSchema,
  createReceiptSchema,
  createTransferSchema,
  formLines,
  formToObject,
  RECEIPT_LINE_FIELDS,
  receiptIdSchema,
  toReceiptItems,
  toTransferItems,
  TRANSFER_LINE_FIELDS,
  transferIdSchema,
  validationCode,
} from "./schemas";
import type { ActionFailure, ActionResult, ActionState, AdjustmentState } from "./types";

/**
 * Inventory mutations. Each action validates FormData and calls api.* commands
 * as the signed-in user (callCommand). Stock only moves inside those commands,
 * in one transaction, through the append-only ledger; there is no edit or
 * delete path here, and corrections are new movements. Hidden inputs only
 * identify records: Postgres re-checks permission, warehouse scope and limits.
 */

const PAGES = {
  stock: "/[locale]/inventory",
  stockDetail: "/[locale]/inventory/stock/[variantId]",
  movements: "/[locale]/inventory/movements",
  receipts: "/[locale]/inventory/receipts",
  receipt: "/[locale]/inventory/receipts/[receiptId]",
  transfers: "/[locale]/inventory/transfers",
} as const;

/** Every stock-moving command changes balances, so the stock pages and the ledger are always stale too. */
function refresh(...pages: (keyof typeof PAGES)[]) {
  for (const page of new Set<keyof typeof PAGES>([...pages, "stock", "stockDetail", "movements"])) revalidatePath(PAGES[page], "page");
}

const failed = (error: AppError): ActionFailure => ({ ok: false, code: error.code, messageKey: error.messageKey, requestId: error.requestId });

function invalid(error: z.ZodError): ActionFailure {
  const code = validationCode(error);
  return { ok: false, code, messageKey: code === "REASON_REQUIRED" ? "REASON_REQUIRED" : "VALIDATION" };
}

// ---------------------------------------------------------------------------
// Goods receipts: create a draft (no stock moves), then post it.
// ---------------------------------------------------------------------------

export async function createReceipt(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = createReceiptSchema.safeParse({ ...formToObject(form), lines: formLines(form, RECEIPT_LINE_FIELDS) });
  if (!parsed.success) return invalid(parsed.error);
  const { warehouse_id, supplier, shipment_ref, lines } = parsed.data;
  const result = await callCommand<{ receipt_id: string; receipt_no: string; status: string }>("create_goods_receipt", {
    p_warehouse_id: warehouse_id,
    p_supplier: supplier,
    p_shipment_ref: shipment_ref ?? null,
    p_items: toReceiptItems(lines),
  });
  if (!result.ok) return failed(result.error);
  refresh("receipts");
  redirect(`/${parsed.data.locale}/inventory/receipts/${result.data.receipt_id}`);
}

export async function postReceipt(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = receiptIdSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const result = await callCommand("post_goods_receipt", { p_receipt_id: parsed.data.receipt_id });
  if (!result.ok) return failed(result.error);
  refresh("receipts", "receipt");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Transfers: draft → in_transit (stock leaves the source) → received.
// ---------------------------------------------------------------------------

export async function createTransfer(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = createTransferSchema.safeParse({ ...formToObject(form), lines: formLines(form, TRANSFER_LINE_FIELDS) });
  if (!parsed.success) return invalid(parsed.error);
  const { from_warehouse_id, to_warehouse_id, lines, locale } = parsed.data;
  const result = await callCommand<{ transfer_id: string; transfer_no: string; status: string }>("create_transfer", {
    p_from: from_warehouse_id,
    p_to: to_warehouse_id,
    p_items: toTransferItems(lines),
  });
  if (!result.ok) return failed(result.error);
  refresh("transfers");
  redirect(`/${locale}/inventory/transfers?highlight=${result.data.transfer_id}`);
}

export async function shipTransfer(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = transferIdSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const result = await callCommand("ship_transfer", { p_transfer_id: parsed.data.transfer_id });
  if (!result.ok) return failed(result.error);
  refresh("transfers");
  return { ok: true };
}

export async function receiveTransfer(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = transferIdSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const result = await callCommand("receive_transfer", { p_transfer_id: parsed.data.transfer_id });
  if (!result.ok) return failed(result.error);
  refresh("transfers");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Adjustments: posted within the cumulative daily limit, otherwise an approval
// request (audit finding #3). The idempotency key makes a retry replay.
// ---------------------------------------------------------------------------

export async function requestAdjustment(_prev: AdjustmentState, form: FormData): Promise<AdjustmentState> {
  const raw = formToObject(form);
  const parsed = adjustmentSchema.safeParse(raw);
  // Keep the submitted key (or mint one if it was missing/garbled) so a retry stays idempotent.
  const submittedKey = raw.idempotency_key ?? "";
  const keyOnFailure = /^[A-Za-z0-9:_-]{8,100}$/.test(submittedKey) ? submittedKey : randomUUID();
  if (!parsed.success) return { ...invalid(parsed.error), idempotencyKey: keyOnFailure };

  const { warehouse_id, line, direction, quantity, reason_code, note, idempotency_key } = parsed.data;
  const result = await callCommand("request_inventory_adjustment", {
    p_warehouse_id: warehouse_id,
    p_variant_id: line.variantId,
    p_lot_id: line.lotId,
    p_quantity: signedQuantity(direction, quantity),
    p_reason: composeReason(reason_code, note),
    p_idempotency_key: idempotency_key,
  });
  if (!result.ok) return { ...failed(result.error), idempotencyKey: idempotency_key };

  refresh();
  return { ok: true, ...parseAdjustmentResult(result.data), nextKey: randomUUID() };
}
