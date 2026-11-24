"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/primitives";
import type { OfferErrorCode } from "../types";

const OWN = ["DUPLICATE_CODE", "CUSTOMER_NOT_FOUND", "OWNER_ONLY"];

/** Translated offer error: orders.offerAdmin.errors.* for offer codes, orders.errors.* for the rest. */
export function OfferError({ code, requestId, detail }: { code: OfferErrorCode; requestId?: string; detail?: string }) {
  const tOwn = useTranslations("orders.offerAdmin.errors");
  const tOrders = useTranslations("orders.errors");
  return <Alert>{OWN.includes(code) ? tOwn(code, { detail: detail ?? "" }) : tOrders(code, { requestId: requestId ?? "—" })}</Alert>;
}
