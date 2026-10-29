"use client";

import type { ButtonProps } from "@/components/ui/button";
import type { ActionResult, ActionState } from "../types";
import { ActionForm, SubmitButton } from "./action-form";

/**
 * One-button action on a record (discontinue, reactivate, end, remove). Hidden
 * fields only identify the record; the database decides whether the user may act.
 */
export function RowAction({
  action,
  fields,
  label,
  confirmText,
  variant = "outline",
  size,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionResult>;
  fields: Record<string, string>;
  label: string;
  confirmText?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
}) {
  return (
    <ActionForm action={action} confirmText={confirmText} className="inline-flex flex-col gap-1" messageClassName="max-w-xs">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton variant={variant} size={size} className={size === "sm" ? "min-h-11 sm:min-h-9" : undefined}>
        {label}
      </SubmitButton>
    </ActionForm>
  );
}
