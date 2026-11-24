import { can, type UserContext } from "@/lib/authz/can";
import type { AppError } from "@/lib/errors";
import { orderErrorCode, parseAmount } from "@/modules/orders/logic";
import type { OfferErrorCode, OfferItemDraft, OfferRow, PricingMode } from "./types";

/**
 * Pure rules of the offers screens. Showing a button is cosmetic: api.upsert_offer
 * and api.set_offer_active check sales.offer.manage (company-wide) in Postgres, and
 * api.set_product_vat_rate checks that the caller is the owner.
 */

/** Owner by default (implicit); any role the owner gives sales.offer.manage. */
export const canManageOffers = (ctx: UserContext) => can(ctx, "sales.offer.manage", "all");
/** Sellers and price readers see the offers (RLS on sales.offers decides the rows). */
export const canReadOffers = (ctx: UserContext) =>
  can(ctx, "sales.offer.manage") || can(ctx, "catalog.price.read") || can(ctx, "sales.order.create");
/** VAT rates are an owner decision (decision C). */
export const canSetVat = (ctx: UserContext) => ctx.active && ctx.is_owner;

export type OfferState = "active" | "scheduled" | "expired" | "inactive";

/** Where an offer stands on a Cairo business day (YYYY-MM-DD). */
export function offerState(offer: Pick<OfferRow, "is_active" | "valid_from" | "valid_to">, today: string): OfferState {
  if (!offer.is_active) return "inactive";
  if (today < offer.valid_from) return "scheduled";
  if (offer.valid_to !== null && today > offer.valid_to) return "expired";
  return "active";
}

export function offerStateTone(state: OfferState): "success" | "info" | "neutral" | "warning" {
  return state === "active" ? "success" : state === "scheduled" ? "info" : state === "expired" ? "warning" : "neutral";
}

/** Today in Cairo as YYYY-MM-DD. */
export function cairoToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** "tier:gold, vip" → ["tier:gold", "vip"] (trimmed, unique, at most 20 of 60 characters). */
export function parseTags(raw: string): string[] | null {
  const tags = [...new Set(raw.split(/[,\n،]/).map((t) => t.trim()).filter(Boolean))];
  return tags.length <= 20 && tags.every((t) => t.length <= 60) ? tags : null;
}

/** "C-0001, C-0002" → unique customer numbers (at most 500). */
export function parseCustomerNos(raw: string): string[] | null {
  const nos = [...new Set(raw.split(/[\s,،;]+/).map((t) => t.trim()).filter(Boolean))];
  return nos.length <= 500 && nos.every((n) => n.length <= 40) ? nos : null;
}

/** The items of the form as api.upsert_offer takes them, or null when one is not valid for the mode. */
export function itemsPayload(
  items: readonly OfferItemDraft[],
  mode: PricingMode,
): { variant_id: string; quantity: number; is_bonus?: true; net_unit_price?: number }[] | null {
  if (items.length === 0 || items.length > 50) return null;
  const out: { variant_id: string; quantity: number; is_bonus?: true; net_unit_price?: number }[] = [];
  const seen = new Set<string>();
  let paid = 0;
  for (const i of items) {
    const q = Number(i.quantity);
    if (!Number.isInteger(q) || q < 1 || q > 100_000) return null;
    const key = `${i.variant_id}:${i.is_bonus}`;
    if (seen.has(key)) return null;
    seen.add(key);
    if (i.is_bonus) {
      out.push({ variant_id: i.variant_id, quantity: q, is_bonus: true });
      continue;
    }
    paid++;
    if (mode === "per_line") {
      const net = parseAmount(i.net_unit_price);
      if (net === null) return null;
      out.push({ variant_id: i.variant_id, quantity: q, net_unit_price: net });
    } else {
      out.push({ variant_id: i.variant_id, quantity: q });
    }
  }
  return paid > 0 ? out : null;
}

const OFFER_CODES = ["DUPLICATE_CODE", "CUSTOMER_NOT_FOUND", "OWNER_ONLY"] as const;

/** Which message to show for a failed offer or VAT command. */
export function offerErrorCode(error: Pick<AppError, "code" | "messageKey" | "detail">): OfferErrorCode {
  if ((OFFER_CODES as readonly string[]).includes(error.code)) return error.code as OfferErrorCode;
  return orderErrorCode(error);
}
