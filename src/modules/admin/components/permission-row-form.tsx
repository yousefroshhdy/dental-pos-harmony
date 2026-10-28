"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/primitives";
import type { Scope } from "@/lib/authz/can";
import { removeRolePermission, setRolePermission } from "../actions";
import { ActionMessage } from "./action-message";

/** Edit one permission of a role: scope (only the permission's allowed scopes), optional limit, remove. */
export function PermissionRowForm({
  roleId,
  permission,
  scopes,
  defaultScope,
  supportsLimit,
  limit,
  granted,
}: {
  roleId: string;
  permission: string;
  scopes: Scope[];
  defaultScope: Scope;
  supportsLimit: boolean;
  limit: number | null;
  granted: boolean;
}) {
  const t = useTranslations("admin.roles");
  const tScopes = useTranslations("scopes");
  const [saveState, saveAction, saving] = useActionState(setRolePermission, null);
  const [removeState, removeAction, removing] = useActionState(removeRolePermission, null);
  const id = useId();
  const pending = saving || removing;

  return (
    <form action={saveAction} className="flex flex-col gap-2">
      <input type="hidden" name="role_id" value={roleId} />
      <input type="hidden" name="permission" value={permission} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="space-y-1">
          <Label htmlFor={`${id}-scope`} className="text-xs text-muted-foreground">
            {t("scope")}
          </Label>
          <Select id={`${id}-scope`} name="scope" defaultValue={defaultScope} className="w-full sm:w-40">
            {scopes.map((s) => (
              <option key={s} value={s}>
                {tScopes(s)}
              </option>
            ))}
          </Select>
        </div>
        {supportsLimit ? (
          <div className="space-y-1">
            <Label htmlFor={`${id}-limit`} className="text-xs text-muted-foreground">
              {t("limit")}
            </Label>
            <Input
              id={`${id}-limit`}
              name="limit"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              defaultValue={limit ?? ""}
              placeholder={t("noLimit")}
              dir="ltr"
              className="sm:w-32"
            />
          </div>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {granted ? t("save") : t("grant")}
          </Button>
          {granted ? (
            <Button type="submit" variant="outline" formAction={removeAction} formNoValidate disabled={pending}>
              {t("remove")}
            </Button>
          ) : null}
        </div>
      </div>
      <ActionMessage state={saveState} success={t("saved")} />
      <ActionMessage state={removeState} />
    </form>
  );
}
