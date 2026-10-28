"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { inviteUser } from "../actions";
import type { InviteState } from "../types";
import { ErrorMessage } from "./action-message";

const STAGE_MESSAGE = {
  input: "invalid",
  permission: null,
  employee: null,
  invite: "inviteFailed",
  link: "linkFailed",
} as const;

/**
 * Invite a colleague: creates the employee record, sends the Supabase invite
 * email and links the login. On success the action redirects to the new
 * user's access page. After a partial failure the ids of what already exists
 * come back so that submitting again resumes instead of duplicating.
 */
export function InviteForm({ uiLocale }: { uiLocale: string }) {
  const t = useTranslations("admin.invite");
  const [state, formAction, pending] = useActionState<InviteState, FormData>(inviteUser, null);

  const values = state?.values ?? {};
  const invalid = new Set(state?.invalidFields ?? []);
  const resuming = Boolean(state?.employeeId);
  const stageMessage = state ? STAGE_MESSAGE[state.stage] : null;

  const field = (name: string) => ({
    id: `invite-${name}`,
    name,
    defaultValue: values[name] ?? "",
    "aria-invalid": invalid.has(name) || undefined,
    // Once the employee exists its details are fixed; only the preferred language can still change.
    disabled: resuming && name !== "locale" ? true : undefined,
  });

  return (
    // `key` remounts the form after each result so defaultValues refill from `values`.
    <form key={JSON.stringify(state)} action={formAction} className="grid gap-4 sm:grid-cols-2" noValidate>
      <input type="hidden" name="ui_locale" value={uiLocale} />
      {state?.employeeId ? <input type="hidden" name="resume_employee_id" value={state.employeeId} /> : null}
      {state?.userId ? <input type="hidden" name="resume_user_id" value={state.userId} /> : null}
      {/* Disabled inputs are not submitted; resend the original values so validation passes. */}
      {resuming
        ? (["employee_no", "full_name_en", "full_name_ar", "job_title", "email", "phone"] as const).map((name) =>
            values[name] ? <input key={name} type="hidden" name={name} value={values[name]} /> : null,
          )
        : null}

      {state ? (
        <div className="space-y-2 sm:col-span-2">
          {stageMessage ? <Alert tone={state.stage === "input" ? "danger" : "info"}>{t(stageMessage)}</Alert> : null}
          {state.stage !== "input" ? <ErrorMessage messageKey={state.messageKey} requestId={state.requestId} /> : null}
          {resuming ? <p className="text-sm text-muted-foreground">{t("resumeNotice")}</p> : null}
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="invite-employee_no">{t("employeeNo")}</Label>
        <Input {...field("employee_no")} required maxLength={40} dir="ltr" autoComplete="off" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-job_title">{t("jobTitle")}</Label>
        <Input {...field("job_title")} required minLength={2} maxLength={120} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-full_name_en">{t("fullNameEn")}</Label>
        <Input {...field("full_name_en")} required minLength={2} maxLength={160} dir="ltr" autoComplete="off" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-full_name_ar">
          {t("fullNameAr")} <span className="text-muted-foreground">({t("optional")})</span>
        </Label>
        <Input {...field("full_name_ar")} maxLength={160} dir="rtl" autoComplete="off" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-email">{t("email")}</Label>
        <Input {...field("email")} type="email" inputMode="email" required maxLength={254} dir="ltr" autoComplete="off" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-phone">
          {t("phone")} <span className="text-muted-foreground">({t("optional")})</span>
        </Label>
        <Input {...field("phone")} type="tel" inputMode="tel" dir="ltr" aria-describedby="invite-phone-hint" autoComplete="off" />
        <p id="invite-phone-hint" className="text-xs text-muted-foreground">
          {t("phoneHint")}
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="invite-locale">{t("locale")}</Label>
        <Select {...field("locale")} defaultValue={values.locale ?? "ar"} className="w-full">
          <option value="ar">{t("localeAr")}</option>
          <option value="en">{t("localeEn")}</option>
        </Select>
      </div>

      <div className="sm:col-span-2">
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {state?.stage === "link" ? t("retryLink") : state?.stage === "invite" ? t("retryInvite") : t("submit")}
        </Button>
      </div>
    </form>
  );
}
