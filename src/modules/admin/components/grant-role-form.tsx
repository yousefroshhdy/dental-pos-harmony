"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
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
  const tx = useTranslations("setup.console");
  const [state, formAction, pending] = useActionState(grantRole, null);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [territoryId, setTerritoryId] = useState<string | null>(null);

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="user_id" value={userId} />
      <FormField label={t("role")} required>
        <Combobox
          name="role_id"
          options={roles}
          value={roleId}
          onValueChange={setRoleId}
          placeholder={t("selectRole")}
          searchPlaceholder={tx("searchRoles")}
          emptyText={tx("noMatch")}
        />
      </FormField>
      <FormField label={t("territoryOptional")}>
        <Combobox
          name="territory_id"
          options={territories}
          value={territoryId}
          onValueChange={setTerritoryId}
          placeholder={t("noTerritory")}
          searchPlaceholder={tx("searchTerritories")}
          emptyText={tx("noMatch")}
        />
      </FormField>
      <FormField label={tCommon("reason")} required className="sm:col-span-2">
        <Input name="reason" required minLength={3} maxLength={500} placeholder={tCommon("reasonPlaceholder")} autoComplete="off" />
      </FormField>
      <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:items-center">
        <Button type="submit" disabled={pending || roles.length === 0 || roleId === null}>
          {t("grantSubmit")}
        </Button>
        <ActionMessage state={state} success={t("granted")} className="flex-1" />
      </div>
    </form>
  );
}
