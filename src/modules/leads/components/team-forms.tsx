"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { reassignAllLeads, runDiscoveryNow, setLeadRadius } from "../actions";
import type { LeadsActionState } from "../types";
import { LeadsActionMessage } from "./action-message";
import type { Option } from "./lead-forms";

/** Owner: run discovery for one rep now (the caps still apply). */
export function RunNowForm({ employeeId, disabled }: { employeeId: string; disabled?: boolean }) {
  const t = useTranslations("leads.team");
  const [state, action, pending] = useActionState<LeadsActionState, FormData>(runDiscoveryNow, null);
  return (
    <div className="space-y-2">
      <form action={action}>
        <input type="hidden" name="employee_id" value={employeeId} />
        <Button type="submit" variant="outline" className="min-h-11" disabled={pending || disabled}>
          {pending ? t("running") : t("runNow")}
        </Button>
      </form>
      <LeadsActionMessage state={state} />
    </div>
  );
}

/** Owner: a rep's lead radius (km); saving queues a new discovery run. */
export function RadiusForm({ employeeId, radiusKm }: { employeeId: string; radiusKm: number }) {
  const t = useTranslations("leads.team");
  const [state, action, pending] = useActionState<LeadsActionState, FormData>(setLeadRadius, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="employee_id" value={employeeId} />
      <div className="flex items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`radius-${employeeId}`}>{t("radius")}</Label>
          <Input
            id={`radius-${employeeId}`}
            name="radius_km"
            type="number"
            inputMode="decimal"
            min={0.5}
            max={50}
            step={0.5}
            defaultValue={radiusKm}
            className="w-28"
            dir="ltr"
          />
        </div>
        <Button type="submit" variant="outline" className="min-h-11" disabled={pending}>
          {t("saveRadius")}
        </Button>
      </div>
      <LeadsActionMessage state={state} />
    </form>
  );
}

/** Move every open lead of one rep to another (crm.lead.assign over both). */
export function BulkReassignForm({ employees }: { employees: Option[] }) {
  const t = useTranslations("leads.team.bulk");
  const [state, action, pending] = useActionState<LeadsActionState, FormData>(reassignAllLeads, null);
  if (employees.length < 2) return null;
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-4 sm:items-end">
      <div className="space-y-1">
        <Label htmlFor="bulk-from">{t("from")}</Label>
        <NativeSelect id="bulk-from" name="from_employee_id" required defaultValue="">
          <option value="" disabled>
            {t("choose")}
          </option>
          {employees.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor="bulk-to">{t("to")}</Label>
        <NativeSelect id="bulk-to" name="employee_id" required defaultValue="">
          <option value="" disabled>
            {t("choose")}
          </option>
          {employees.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor="bulk-reason">{t("reason")}</Label>
        <Input id="bulk-reason" name="reason" required minLength={3} maxLength={500} />
      </div>
      <Button type="submit" variant="outline" className="min-h-11" disabled={pending}>
        {t("submit")}
      </Button>
      <div className="sm:col-span-4">
        <LeadsActionMessage state={state} />
      </div>
    </form>
  );
}
