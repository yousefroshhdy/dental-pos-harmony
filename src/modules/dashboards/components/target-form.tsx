"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { setKpiTarget } from "../actions";
import { TARGET_SUBJECTS } from "../schemas";

type SubjectKind = (typeof TARGET_SUBJECTS)[number];
interface Choice {
  id: string;
  label: string;
}

/**
 * Set a target for one employee, a role (each holder) or a territory (its total).
 * The server generated `targetId`; a re-submit of the same form is a replay.
 */
export function TargetForm({
  targetId,
  kpis,
  employees,
  roles,
  territories,
  defaultStart,
  defaultEnd,
}: {
  targetId: string;
  kpis: readonly Choice[];
  employees: readonly Choice[];
  roles: readonly Choice[];
  territories: readonly Choice[];
  defaultStart: string;
  defaultEnd: string;
}) {
  const t = useTranslations("dashboards.targets");
  const tErr = useTranslations("dashboards.errors");
  const [state, formAction, pending] = useActionState(setKpiTarget, null);
  const [subject, setSubject] = useState<SubjectKind>("employee");
  const options = { employee: employees, role: roles, territory: territories }[subject];

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="target_id" value={targetId} />
      <div className="flex flex-col gap-1">
        <Label htmlFor="target-kpi">{t("kpi")}</Label>
        <Select id="target-kpi" name="kpi_code" required>
          {kpis.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="target-subject">{t("subject")}</Label>
        <Select id="target-subject" name="subject" value={subject} onChange={(e) => setSubject(e.target.value as SubjectKind)}>
          {TARGET_SUBJECTS.map((s) => (
            <option key={s} value={s}>
              {t(`subjects.${s}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <Label htmlFor="target-subject-id">{t(`subjects.${subject}`)}</Label>
        <Select id="target-subject-id" key={subject} name={`${subject}_id`} required>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{t(`subjectHint.${subject}`)}</p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="target-start">{t("periodStart")}</Label>
        <Input id="target-start" name="period_start" type="date" required defaultValue={defaultStart} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="target-end">{t("periodEnd")}</Label>
        <Input id="target-end" name="period_end" type="date" required defaultValue={defaultEnd} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="target-value">{t("value")}</Label>
        <Input id="target-value" name="target_value" type="number" inputMode="decimal" min={0} step="0.01" required dir="ltr" />
        <p className="text-xs text-muted-foreground">{t("valueHint")}</p>
      </div>
      <div className="flex flex-col justify-end gap-2 sm:col-span-2">
        {state && !state.ok ? <Alert>{tErr(state.errorCode, { requestId: state.requestId ?? "—" })}</Alert> : null}
        {state?.ok ? (
          <Alert tone="success" role="status">
            {t("saved")}
          </Alert>
        ) : null}
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? t("saving") : t("save")}
        </Button>
      </div>
    </form>
  );
}
