"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/primitives";
import { issueLogin, type LoginState } from "../../setup-actions";
import { ErrorMessage } from "../action-message";

export interface Choice {
  id: string;
  label: string;
}

/**
 * Login + role for one person. E-mail invites need SMTP, which is not set up, so the result is a
 * one-time link the owner copies and sends privately (WhatsApp, SMS). It is shown once and never
 * stored; generating a new one is always possible.
 */
export function LoginForm({
  employeeId,
  hasLogin,
  roles,
  territories,
  defaultRoleId,
}: {
  employeeId: string;
  hasLogin: boolean;
  roles: Choice[];
  territories: Choice[];
  defaultRoleId?: string;
}) {
  const t = useTranslations("setup.login");
  const [state, action, pending] = useActionState<LoginState, FormData>(issueLogin, null);
  const [copied, setCopied] = useState(false);
  const ids = { role: useId(), territory: useId(), locale: useId(), link: useId() };

  return (
    <div className="space-y-3">
      <form action={action} className="grid gap-3 sm:grid-cols-3 sm:items-end">
        <input type="hidden" name="employee_id" value={employeeId} />
        <div className="space-y-1">
          <Label htmlFor={ids.role}>{t("role")}</Label>
          <Select id={ids.role} name="role_id" defaultValue={defaultRoleId ?? ""} className="w-full">
            <option value="">{hasLogin ? t("noNewRole") : t("noRole")}</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={ids.territory}>{t("territory")}</Label>
          <Select id={ids.territory} name="territory_id" defaultValue="" className="w-full">
            <option value="">{t("noTerritory")}</option>
            {territories.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={ids.locale}>{t("language")}</Label>
          <Select id={ids.locale} name="locale" defaultValue="ar" className="w-full">
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </Select>
        </div>
        <div className="sm:col-span-3">
          <Button type="submit" disabled={pending} className="w-full sm:w-auto">
            {hasLogin ? t("submitLink") : t("submitInvite")}
          </Button>
        </div>
      </form>

      <p className="text-xs text-muted-foreground">{t("smtpNote")}</p>

      {state === null ? null : !state.ok ? (
        <ErrorMessage messageKey={state.messageKey} requestId={state.requestId} />
      ) : (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">{state.mode === "invite" ? t("linkInvite", { email: state.email }) : t("linkSignIn", { email: state.email })}</p>
          <Label htmlFor={ids.link} className="sr-only">
            {t("linkLabel")}
          </Label>
          <Input id={ids.link} readOnly dir="ltr" value={state.link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => {
                void navigator.clipboard?.writeText(state.link).then(() => setCopied(true));
              }}
            >
              {copied ? t("copied") : t("copy")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("linkWarning")}</p>
          <ul className="text-xs text-muted-foreground">
            {(["register", "territory", "role"] as const).map((step) =>
              state.steps[step] === "skipped" ? null : (
                <li key={step}>
                  {t(`steps.${step}`)}: {t(`stepStatus.${state.steps[step]}`)}
                </li>
              ),
            )}
          </ul>
          {state.failure ? (
            <div className="space-y-1">
              <p className="text-sm font-medium">{t("partial")}</p>
              <ErrorMessage messageKey={state.failure.messageKey} requestId={state.failure.requestId} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
