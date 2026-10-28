"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { createRole } from "../actions";
import { ActionMessage } from "./action-message";

/** On success the action redirects to the new role's permission matrix. */
export function CreateRoleForm({ locale }: { locale: string }) {
  const t = useTranslations("admin.roles");
  const [state, formAction, pending] = useActionState(createRole, null);

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="locale" value={locale} />
      <div className="space-y-2">
        <Label htmlFor="role-code">{t("code")}</Label>
        <Input
          id="role-code"
          name="code"
          required
          pattern="[a-z][a-z0-9_]{2,40}"
          maxLength={41}
          dir="ltr"
          autoComplete="off"
          aria-describedby="role-code-hint"
        />
        <p id="role-code-hint" className="text-xs text-muted-foreground">
          {t("codeHint")}
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="role-name-en">{t("nameEn")}</Label>
        <Input id="role-name-en" name="name_en" required minLength={2} maxLength={120} dir="ltr" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="role-name-ar">{t("nameAr")}</Label>
        <Input id="role-name-ar" name="name_ar" maxLength={120} dir="rtl" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="role-description">{t("description")}</Label>
        <Input id="role-description" name="description" maxLength={500} />
      </div>
      <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:items-center">
        <Button type="submit" disabled={pending}>
          {t("create")}
        </Button>
        <ActionMessage state={state} className="flex-1" />
      </div>
    </form>
  );
}
