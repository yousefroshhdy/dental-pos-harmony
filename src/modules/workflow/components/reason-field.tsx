"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { Input, Label } from "@/components/ui/primitives";
import { REASON_MAX, REASON_MIN } from "../schemas";

/** "Why does this change?" — required for every workflow configuration change (security event). */
export function ReasonField({ required = true }: { required?: boolean }) {
  const t = useTranslations("workflow.form");
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{required ? t("reason") : t("reasonOptional")}</Label>
      <Input
        id={id}
        name="reason"
        required={required}
        minLength={required ? REASON_MIN : undefined}
        maxLength={REASON_MAX}
        placeholder={t("reasonPlaceholder")}
        autoComplete="off"
      />
    </div>
  );
}
