"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { Input, Label, Select } from "@/components/ui/primitives";
import { localizedName, minutesToHours } from "../logic";
import { APPROVER_TYPES, type ApproverType, type PermissionOption, type PersonRow, type RoleOption } from "../types";

export interface StageOptions {
  permissions: PermissionOption[];
  roles: RoleOption[];
  people: PersonRow[];
}

export interface StageDefaults {
  approver_type: ApproverType;
  approver_permission: string | null;
  approver_role_id: string | null;
  approver_user_id: string | null;
  required_approvals: number;
  escalate_after_minutes: number | null;
  escalate_to_user_id: string | null;
}

export const EMPTY_STAGE: StageDefaults = {
  approver_type: "permission",
  approver_permission: null,
  approver_role_id: null,
  approver_user_id: null,
  required_approvals: 1,
  escalate_after_minutes: null,
  escalate_to_user_id: null,
};

/**
 * Approver fields of one stage. All inputs are present (works without JS); the
 * approver type decides which one is used. Lists only offer what the caller may
 * read — the database re-validates every choice (wf.decide.* permissions only,
 * active users, no self-appointment for non-owners).
 */
export function StageFields({ options, defaults, locale }: { options: StageOptions; defaults: StageDefaults; locale: string }) {
  const t = useTranslations("workflow.stage");
  const tType = useTranslations("workflow.approverType");
  const id = useId();
  const person = (p: PersonRow) => `${localizedName(locale, p.full_name_en, p.full_name_ar)} · ${p.employee_no}`;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label htmlFor={`${id}-type`}>{t("approverType")}</Label>
        <Select id={`${id}-type`} name="approver_type" defaultValue={defaults.approver_type} className="w-full">
          {APPROVER_TYPES.map((type) => (
            <option key={type} value={type}>
              {tType(type)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-perm`}>{t("permission")}</Label>
        <Select id={`${id}-perm`} name="approver_permission" defaultValue={defaults.approver_permission ?? ""} className="w-full" dir="ltr">
          <option value="">{t("choose")}</option>
          {options.permissions.map((p) => (
            <option key={p.code} value={p.code}>
              {p.code}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{t("permissionHint")}</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-role`}>{t("role")}</Label>
        <Select id={`${id}-role`} name="approver_role_id" defaultValue={defaults.approver_role_id ?? ""} className="w-full">
          <option value="">{t("choose")}</option>
          {options.roles.map((r) => (
            <option key={r.id} value={r.id}>
              {localizedName(locale, r.name_en, r.name_ar)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-user`}>{t("user")}</Label>
        <Select id={`${id}-user`} name="approver_user_id" defaultValue={defaults.approver_user_id ?? ""} className="w-full">
          <option value="">{t("choose")}</option>
          {options.people.map((p) => (
            <option key={p.user_id} value={p.user_id}>
              {person(p)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-req`}>{t("requiredApprovals")}</Label>
        <Input
          id={`${id}-req`}
          name="required_approvals"
          type="number"
          inputMode="numeric"
          min={1}
          max={5}
          defaultValue={defaults.required_approvals}
          dir="ltr"
        />
        <p className="text-xs text-muted-foreground">{t("requiredHint")}</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-esc`}>{t("escalateAfter")}</Label>
        <Input
          id={`${id}-esc`}
          name="escalate_after_hours"
          type="number"
          inputMode="decimal"
          min={0.25}
          max={720}
          step="0.25"
          defaultValue={minutesToHours(defaults.escalate_after_minutes) ?? ""}
          placeholder={t("noEscalation")}
          dir="ltr"
        />
        <p className="text-xs text-muted-foreground">{t("escalateHint")}</p>
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor={`${id}-fallback`}>{t("fallback")}</Label>
        <Select id={`${id}-fallback`} name="escalate_to_user_id" defaultValue={defaults.escalate_to_user_id ?? ""} className="w-full">
          <option value="">{t("fallbackNone")}</option>
          {options.people.map((p) => (
            <option key={p.user_id} value={p.user_id}>
              {person(p)}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{t("fallbackHint")}</p>
      </div>
    </div>
  );
}
