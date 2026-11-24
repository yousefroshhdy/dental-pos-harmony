"use client";

import { useLocale, useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { convertLead, planLead, reassignLeads, saveLeadNotes, setLeadStatus } from "../actions";
import type { LeadsActionState, ManualLeadStatus } from "../types";
import { LeadsActionMessage } from "./action-message";

/**
 * Small forms for one lead. Every form posts to a server action that calls an api.* command;
 * the database decides (crm.lead.* scope, plan rules, create_customer rules).
 */

export function LeadStatusButtons({ leadId, next }: { leadId: string; next: ManualLeadStatus[] }) {
  const t = useTranslations("leads");
  const [state, action, pending] = useActionState<LeadsActionState, FormData>(setLeadStatus, null);
  if (next.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {next.map((s) => (
          <form key={s} action={action}>
            <input type="hidden" name="lead_id" value={leadId} />
            <input type="hidden" name="status" value={s} />
            <Button type="submit" variant="outline" className="min-h-11" disabled={pending}>
              {t(`statusAction.${s}`)}
            </Button>
          </form>
        ))}
      </div>
      <LeadsActionMessage state={state} />
    </div>
  );
}

export function LeadPlanButton({ leadId, plannedToday, today }: { leadId: string; plannedToday: boolean; today: string }) {
  const t = useTranslations("leads");
  const [state, action, pending] = useActionState<LeadsActionState, FormData>(planLead, null);
  return (
    <div className="space-y-2">
      <form action={action}>
        <input type="hidden" name="lead_id" value={leadId} />
        <input type="hidden" name="date" value={today} />
        <input type="hidden" name="plan" value={plannedToday ? "remove" : "add"} />
        <Button type="submit" size="sm" variant={plannedToday ? "outline" : "default"} className="min-h-11" disabled={pending}>
          {plannedToday ? t("plan.remove") : t("plan.addToday")}
        </Button>
      </form>
      <LeadsActionMessage state={state} />
    </div>
  );
}

export function LeadNotesForm({ leadId, notes }: { leadId: string; notes: string | null }) {
  const t = useTranslations("leads.notes");
  const [state, action, pending] = useActionState<LeadsActionState, FormData>(saveLeadNotes, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="lead_id" value={leadId} />
      <Label htmlFor={`notes-${leadId}`}>{t("label")}</Label>
      <Textarea id={`notes-${leadId}`} name="notes" defaultValue={notes ?? ""} maxLength={2000} rows={3} />
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
      <Button type="submit" variant="outline" className="min-h-11" disabled={pending}>
        {t("save")}
      </Button>
      <LeadsActionMessage state={state} />
    </form>
  );
}

export interface Option {
  value: string;
  label: string;
}

/**
 * First visit: the rep types the clinic's own data (HONEST's record, not Google's). On success
 * the action opens the check-in for the new prospect; the check-in fix becomes the proposed pin.
 */
export function ConvertLeadForm({
  leadId,
  governorates,
  specialties,
  defaultGovernorate,
}: {
  leadId: string;
  governorates: Option[];
  specialties: Option[];
  defaultGovernorate: string | null;
}) {
  const t = useTranslations("leads.convert");
  const locale = useLocale();
  const [clientRef] = useState(() => crypto.randomUUID());
  const [state, action, pending] = useActionState<LeadsActionState, FormData>(convertLead, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="lead_id" value={leadId} />
      <input type="hidden" name="client_ref" value={clientRef} />
      <input type="hidden" name="ui_locale" value={locale} />
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="cv-doctor">{t("doctor")}</Label>
          <Input id="cv-doctor" name="doctor_name" maxLength={120} autoComplete="off" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cv-clinic">{t("clinic")}</Label>
          <Input id="cv-clinic" name="clinic_name" maxLength={160} autoComplete="off" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cv-phone">{t("phone")}</Label>
          <Input id="cv-phone" name="phone" type="tel" inputMode="tel" dir="ltr" maxLength={32} placeholder="01xxxxxxxxx" />
          <p className="text-xs text-muted-foreground">{t("phoneHint")}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="cv-specialty">{t("specialty")}</Label>
          <NativeSelect id="cv-specialty" name="specialty_code" defaultValue="">
            <option value="">{t("noSpecialty")}</option>
            {specialties.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="cv-gov">{t("governorate")}</Label>
          <NativeSelect id="cv-gov" name="governorate_code" required defaultValue={defaultGovernorate ?? ""}>
            <option value="" disabled>
              {t("choose")}
            </option>
            {governorates.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="cv-city">{t("city")}</Label>
          <Input id="cv-city" name="city" maxLength={80} />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="cv-notes">{t("notes")}</Label>
        <Textarea id="cv-notes" name="notes" maxLength={2000} rows={3} />
      </div>
      <p className="text-xs text-muted-foreground">{t("pinHint")}</p>
      <Button type="submit" className="min-h-11 w-full sm:w-auto" disabled={pending}>
        {t("submit")}
      </Button>
      <LeadsActionMessage state={state} />
    </form>
  );
}

export function ReassignLeadForm({ leadId, employees, currentEmployeeId }: { leadId: string; employees: Option[]; currentEmployeeId: string }) {
  const t = useTranslations("leads.reassign");
  const [state, action, pending] = useActionState<LeadsActionState, FormData>(reassignLeads, null);
  const options = employees.filter((e) => e.value !== currentEmployeeId);
  if (options.length === 0) return null;
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="lead_ids" value={leadId} />
      <div className="space-y-1">
        <Label htmlFor={`ra-to-${leadId}`}>{t("to")}</Label>
        <NativeSelect id={`ra-to-${leadId}`} name="employee_id" required defaultValue="">
          <option value="" disabled>
            {t("choose")}
          </option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`ra-reason-${leadId}`}>{t("reason")}</Label>
        <Input id={`ra-reason-${leadId}`} name="reason" required minLength={3} maxLength={500} />
      </div>
      <Button type="submit" variant="outline" className="min-h-11" disabled={pending}>
        {t("submit")}
      </Button>
      <LeadsActionMessage state={state} />
    </form>
  );
}
