"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/primitives";
import { grantRole } from "../actions";
import { ActionMessage } from "./action-message";

export interface Option {
  value: string;
  label: string;
}

/** Grant a role (optionally bound to a territory). The DB applies the escalation ceiling. */
export function GrantRoleForm({ userId, roles, territories }: { userId: string; roles: Option[]; territories: Option[] }) {
  const t = useTranslations("admin.userDetail");
  const tCommon = useTranslations("admin.common");
  const [state, formAction, pending] = useActionState(grantRole, null);

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="user_id" value={userId} />
      <div className="space-y-2">
        <Label htmlFor="grant-role">{t("role")}</Label>
        <Select id="grant-role" name="role_id" required defaultValue="" className="w-full">
          <option value="" disabled>
            {t("selectRole")}
          </option>
          {roles.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="grant-territory">{t("territoryOptional")}</Label>
        <Select id="grant-territory" name="territory_id" defaultValue="" className="w-full">
          <option value="">{t("noTerritory")}</option>
          {territories.map((tr) => (
            <option key={tr.value} value={tr.value}>
              {tr.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="grant-reason">{tCommon("reason")}</Label>
        <Input
          id="grant-reason"
          name="reason"
          required
          minLength={3}
          maxLength={500}
          placeholder={tCommon("reasonPlaceholder")}
          autoComplete="off"
        />
      </div>
      <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:items-center">
        <Button type="submit" disabled={pending || roles.length === 0}>
          {t("grantSubmit")}
        </Button>
        <ActionMessage state={state} success={t("granted")} className="flex-1" />
      </div>
    </form>
  );
}
