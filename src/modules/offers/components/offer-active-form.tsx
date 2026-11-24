"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { setOfferActive } from "../actions";
import type { OfferActionState } from "../types";
import { OfferError } from "./offer-error";

/** Start or end an offer (api.set_offer_active). Submitted orders keep their prices. */
export function OfferActiveForm({ offerId, active }: { offerId: string; active: boolean }) {
  const t = useTranslations("orders.offerAdmin");
  const [state, action, pending] = useActionState<OfferActionState, FormData>(setOfferActive, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="offer_id" value={offerId} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <Button type="submit" variant={active ? "outline" : "default"} disabled={pending}>
        {active ? t("end") : t("start")}
      </Button>
      {state && !state.ok ? <OfferError code={state.errorCode} requestId={state.requestId} /> : null}
    </form>
  );
}
