"use client";

import { PhoneIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { toast } from "@/components/ui/sonner";
import { addCustomerPhone } from "../actions";
import type { FormResultState } from "../types";
import { CrmErrorMessage } from "./crm-error";

/**
 * Quick "add phone" for a customer marked "phone missing": a bottom sheet with one field,
 * on the customer page and on the check-in screens, so a rep completes it at the clinic.
 * The version guards against overwriting an edit made meanwhile (CONFLICT); the command
 * checks scope, format and duplicates again.
 */
export function AddPhoneForm({
  customerId,
  version,
  customerName,
  variant = "outline",
  className,
}: {
  customerId: string;
  version: number;
  customerName?: string;
  variant?: "default" | "outline" | "secondary";
  className?: string;
}) {
  const t = useTranslations("crm.addPhone");
  const tForm = useTranslations("form");
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<FormResultState, FormData>(async (prev, form) => {
    const result = await addCustomerPhone(prev, form);
    if (result?.ok === true) {
      setOpen(false);
      toast.success(t("saved"));
    }
    return result;
  }, null);

  const failure = state && state.ok === false ? state : null;
  const phoneInvalid = failure?.invalidFields?.includes("phone_primary") ?? false;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant={variant} className={className}>
          <PhoneIcon aria-hidden="true" />
          {t("open")}
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" closeLabel={t("cancel")} className="mx-auto w-full max-w-lg">
        <form action={formAction} className="flex flex-col gap-2" noValidate>
          <SheetHeader>
            <SheetTitle>{t("title")}</SheetTitle>
            <SheetDescription>
              {customerName ? <span className="block font-medium text-foreground">{customerName}</span> : null}
              {t("description")}
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-3 px-4">
            <input type="hidden" name="customer_id" value={customerId} />
            <input type="hidden" name="version" value={version} />
            {failure && !phoneInvalid ? <CrmErrorMessage failure={failure} /> : null}
            <FormField label={t("label")} error={phoneInvalid ? tForm("phone") : undefined} required>
              <Input
                key={JSON.stringify(state)}
                name="phone_primary"
                type="tel"
                inputMode="tel"
                dir="ltr"
                autoComplete="tel"
                placeholder="01X XXXX XXXX"
                defaultValue={failure?.values?.phone_primary ?? ""}
                required
                autoFocus
              />
            </FormField>
          </div>
          <SheetFooter className="sm:flex-row">
            <Button type="submit" disabled={pending} className="sm:flex-1">
              {pending ? t("saving") : t("submit")}
            </Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
