"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Alert, Badge } from "@/components/ui/primitives";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { StepUpLink } from "@/modules/security/components/step-up-link";
import { setLotCost } from "../actions";
import type { LotCostStatus, SetLotCostState } from "../types";
import { InventoryError } from "./inventory-error";

/**
 * The cost column of the lot table (cost readers only: the owner and the inventory manager).
 * "Cost unknown" for a lot received without a purchase cost; for the owner, a "Set cost" sheet
 * that records it once (api.set_lot_cost: owner only, MFA, a reason, never overwritten).
 */
export function LotCost({
  status,
  amount,
  setCost,
  className,
}: {
  status: LotCostStatus;
  amount: number | null;
  /** Present for the owner on an unknown-cost lot. */
  setCost?: { lotId: string; variantId: string; lotLabel: string; initialKey: string; stepUpFirst: boolean };
  className?: string;
}) {
  const t = useTranslations("inventory.lotCost");
  const format = useFormatter();
  if (status !== "unknown") {
    return <span className={className}>{amount === null ? "—" : format.number(amount, "egp")}</span>;
  }
  return (
    <span className={className}>
      <span className="inline-flex flex-wrap items-center gap-2">
        <Badge tone="warning">{t("unknown")}</Badge>
        {setCost ? <SetLotCostSheet {...setCost} /> : null}
      </span>
    </span>
  );
}

function SetLotCostSheet({
  lotId,
  variantId,
  lotLabel,
  initialKey,
  stepUpFirst,
}: {
  lotId: string;
  variantId: string;
  lotLabel: string;
  initialKey: string;
  stepUpFirst: boolean;
}) {
  const t = useTranslations("inventory.lotCost");
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(initialKey);
  // Controlled, so a refused attempt keeps what the owner typed (React resets an action form).
  const [cost, setCostText] = useState("");
  const [reason, setReason] = useState("");
  const [state, formAction, pending] = useActionState<SetLotCostState, FormData>(async (prev, form) => {
    const result = await setLotCost(prev, form);
    if (result?.ok) {
      setKey(result.nextKey);
      setOpen(false);
      toast.success(t("saved", { amount: format.number(result.unitCost, "egp") }));
    } else if (result) {
      // Keep the key of this attempt, so sending it again replays rather than failing as already set.
      setKey(result.idempotencyKey);
    }
    return result;
  }, null);

  const failure = state && !state.ok ? state : null;
  const fieldError = failure?.field;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="min-h-11">
          {t("open")}
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" closeLabel={t("cancel")} className="mx-auto w-full max-w-lg">
        <form action={formAction} className="flex flex-col gap-2" noValidate>
          <SheetHeader>
            <SheetTitle>{t("title")}</SheetTitle>
            <SheetDescription>
              <span className="block font-medium text-foreground" dir="auto">
                {lotLabel}
              </span>
              {t("description")}
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-3 px-4">
            <input type="hidden" name="lot_id" value={lotId} />
            <input type="hidden" name="variant_id" value={variantId} />
            <input type="hidden" name="idempotency_key" value={key} />
            {stepUpFirst ? (
              <Alert tone="info">
                {t("stepUpFirst")} <StepUpLink code="MFA_REQUIRED" />
              </Alert>
            ) : null}
            {failure && !fieldError ? <InventoryError code={failure.code} messageKey={failure.messageKey} requestId={failure.requestId} /> : null}
            <FormField label={t("unitCost")} hint={t("unitCostHint")} error={fieldError === "unit_cost" ? t("unitCostInvalid") : undefined} required>
              <Input name="unit_cost" value={cost} onChange={(e) => setCostText(e.target.value)} inputMode="decimal" dir="ltr" autoComplete="off" required autoFocus />
            </FormField>
            <FormField label={t("reason")} hint={t("reasonHint")} error={fieldError === "reason" ? t("reasonInvalid") : undefined} required>
              <Textarea name="reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} rows={3} required />
            </FormField>
          </div>
          <SheetFooter className="sm:flex-row">
            <Button type="submit" disabled={pending} aria-busy={pending || undefined} className="min-h-11 sm:flex-1">
              {pending ? t("saving") : t("submit")}
            </Button>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
