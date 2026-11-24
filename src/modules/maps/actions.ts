"use server";

import { revalidatePath } from "next/cache";
import { callCommand } from "@/lib/command";
import { toMapsFailure } from "./logic";
import { decideProposalSchema, formToObject, mapLocationSchema } from "./schemas";
import type { MapsActionResult, MapsActionState } from "./types";

/**
 * Maps mutations, as the signed-in user through api.* commands. Hidden inputs are untrusted:
 * the database re-checks crm.customer_location.verify, the customer scope and every rule.
 */

function refresh() {
  revalidatePath("/[locale]/map", "page");
  revalidatePath("/[locale]/map/proposals", "page");
  revalidatePath("/[locale]/customers/[id]", "page");
}

/** Approve or reject a pin proposed by a rep's first check-in (api.decide_customer_location_proposal). */
export async function decideLocationProposal(_prev: MapsActionState, form: FormData): Promise<MapsActionResult> {
  const parsed = decideProposalSchema.safeParse(formToObject(form));
  if (!parsed.success) {
    const reason = parsed.error.issues.some((i) => i.path[0] === "note");
    return { ok: false, messageKey: reason ? "REASON_REQUIRED" : "VALIDATION" };
  }
  const { proposal_id, decision, note } = parsed.data;
  const result = await callCommand("decide_customer_location_proposal", {
    p_proposal_id: proposal_id,
    p_approve: decision === "approve",
    p_note: note ?? null,
  });
  if (!result.ok) return toMapsFailure(result.error);
  refresh();
  return { ok: true };
}

/**
 * An office user's clinic location from the map: an address search result or a dropped pin.
 * Same command and rule as before (api.set_customer_location, crm.customer_location.verify);
 * the source is for the UI only.
 */
export async function setCustomerLocationFromMap(_prev: MapsActionState, form: FormData): Promise<MapsActionResult> {
  const parsed = mapLocationSchema.safeParse(formToObject(form));
  if (!parsed.success) {
    const outside = parsed.error.issues.some((i) => i.path[0] === "latitude" || i.path[0] === "longitude");
    return outside ? { ok: false, messageKey: "VALIDATION", mapsCode: "OUTSIDE_EGYPT" } : { ok: false, messageKey: "VALIDATION" };
  }
  const { customer_id, latitude, longitude } = parsed.data;
  const result = await callCommand("set_customer_location", {
    p_customer_id: customer_id,
    p_lat: Number(latitude.toFixed(6)),
    p_lng: Number(longitude.toFixed(6)),
  });
  if (!result.ok) return toMapsFailure(result.error);
  refresh();
  return { ok: true };
}
