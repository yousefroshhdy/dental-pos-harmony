"use server";

import { revalidatePath } from "next/cache";
import { callCommand } from "@/lib/command";
import { formToObject } from "@/modules/orders/schemas";
import { offerErrorCode } from "./logic";
import { customersByNo } from "./queries";
import { offerActiveSchema, offerInputSchema, type OfferInput } from "./schemas";
import type { OfferActionResult, OfferActionState } from "./types";

/**
 * Offer mutations (owner by default: sales.offer.manage). Each action validates its
 * input and calls one api.* command as the signed-in user; the database decides
 * permission and re-validates every field.
 */

function refresh() {
  revalidatePath("/[locale]/offers", "layout");
  revalidatePath("/[locale]/orders/new", "page");
}

/** Create or replace an offer: header, items and targets in one command (api.upsert_offer). */
export async function saveOffer(input: OfferInput): Promise<OfferActionResult> {
  const parsed = offerInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errorCode: "VALIDATION" };
  const o = parsed.data;

  // Targets by customer number → ids the user can see; an unknown number is reported, never dropped.
  const found = await customersByNo(o.customer_nos);
  if (!found.ok) return { ok: false, errorCode: offerErrorCode(found.error), requestId: found.error.requestId };
  const byNo = new Map(found.data.map((c) => [c.customer_no, c.id]));
  const missing = o.customer_nos.filter((n) => !byNo.has(n));
  if (missing.length > 0) return { ok: false, errorCode: "CUSTOMER_NOT_FOUND", detail: missing.slice(0, 10).join(", ") };

  const result = await callCommand<{ offer_id: string; version: number }>("upsert_offer", {
    p_offer_id: o.offer_id,
    p_code: o.code,
    p_name_en: o.name_en,
    p_name_ar: o.name_ar,
    p_pricing_mode: o.pricing_mode,
    p_package_price: o.pricing_mode === "package" ? o.package_price : null,
    p_valid_from: o.valid_from,
    p_valid_to: o.valid_to,
    p_items: o.items,
    p_customer_ids: o.customer_nos.map((n) => byNo.get(n)),
    p_target_tags: o.target_tags,
    p_description: o.description,
    p_expected_version: o.expected_version,
  });
  if (!result.ok) return { ok: false, errorCode: offerErrorCode(result.error), requestId: result.error.requestId };
  refresh();
  return { ok: true, offerId: result.data.offer_id, version: result.data.version };
}

/** Start or end an offer (api.set_offer_active). */
export async function setOfferActive(_prev: OfferActionState, form: FormData): Promise<OfferActionResult> {
  const parsed = offerActiveSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, errorCode: "VALIDATION" };
  const result = await callCommand("set_offer_active", { p_offer_id: parsed.data.offer_id, p_active: parsed.data.active === "true" });
  if (!result.ok) return { ok: false, errorCode: offerErrorCode(result.error), requestId: result.error.requestId };
  refresh();
  return { ok: true };
}
