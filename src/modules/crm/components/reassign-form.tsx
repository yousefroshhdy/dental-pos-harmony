"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/primitives";
import { requestReassignment } from "../actions";
import type { FormResultState } from "../types";
import { CrmActionMessage } from "./crm-error";
import type { Option } from "./customer-form";

/**
 * Ask for the customer to move to another representative. This only opens an
 * approval request (crm.customer.reassign workflow); nothing changes until an
 * approver decides it in the approvals inbox.
 */
export function ReassignForm({ customerId, employees }: { customerId: string; employees: Option[] }) {
  const t = useTranslations("crm.reassign");
  const [state, formAction, pending] = useActionState<FormResultState, FormData>(requestReassignment, null);
  const uid = useId();
  const failed = state && !state.ok ? state : null;
  const values = failed?.values ?? {};
  const invalid = new Set(failed?.invalidFields ?? []);

  return (
    <form key={JSON.stringify(state)} action={formAction} className="space-y-3">
      <input type="hidden" name="customer_id" value={customerId} />
      <p className="text-sm text-muted-foreground">{t("hint")}</p>
      <div className="space-y-2">
        <Label htmlFor={`${uid}-to`}>{t("to")}</Label>
        <Select
          id={`${uid}-to`}
          name="to_employee_id"
          required
          defaultValue={values.to_employee_id ?? ""}
          className="w-full"
          aria-invalid={invalid.has("to_employee_id") || undefined}
        >
          <option value="">{t("choose")}</option>
          {employees.map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${uid}-reason`}>{t("reason")}</Label>
        <Input
          id={`${uid}-reason`}
          name="reason"
          required
          minLength={3}
          maxLength={500}
          defaultValue={values.reason ?? ""}
          placeholder={t("reasonPlaceholder")}
          autoComplete="off"
          aria-invalid={invalid.has("reason") || undefined}
        />
      </div>
      <Button type="submit" variant="outline" disabled={pending} className="w-full sm:w-auto">
        {t("submit")}
      </Button>
      <CrmActionMessage state={state} success={t("sent")} />
    </form>
  );
}
