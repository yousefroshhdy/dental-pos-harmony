"use client";

import { Slot } from "@radix-ui/react-slot";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Label } from "./label";

/**
 * One form field: label, the control, a hint and an inline validation message.
 * The control is the single child; FormField gives it the id, `aria-invalid` and
 * `aria-describedby`, so the message is read with the field. Messages come from
 * the caller's own translations (Arabic first), typically the field errors a
 * zod schema / server action returned:
 *
 *   <FormField label={t("phone")} hint={t("phoneHint")} error={state.errors?.phone && t(`errors.${state.errors.phone}`)} required>
 *     <Input name="phone" inputMode="tel" dir="ltr" />
 *   </FormField>
 *
 * The error paragraph has role="alert", so a screen reader announces it when it
 * appears (after submit). For zod issues, `validationMessage` (form-messages.ts)
 * maps an issue to the shared `form.*` strings in messages/{ar,en}.json.
 */
export function FormField({
  label,
  hint,
  error,
  required = false,
  requiredMark = "*",
  optionalText,
  id: idProp,
  className,
  layout = "stacked",
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Visual marker after the label of a required field (hidden from screen readers; `required` on the input says it). */
  requiredMark?: string;
  /** Shown after the label of an optional field, e.g. "(اختياري)". */
  optionalText?: ReactNode;
  id?: string;
  className?: string;
  /** "inline": control before label in one 44 px row (checkboxes). */
  layout?: "stacked" | "inline";
  children: ReactNode;
}) {
  const autoId = useId();
  const id = idProp ?? `field-${autoId}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  const control = (
    <Slot id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} aria-required={required || undefined}>
      {children}
    </Slot>
  );
  const labelNode = (
    <Label htmlFor={id}>
      {label}
      {required ? (
        <span aria-hidden="true" className="ms-0.5 text-destructive">
          {requiredMark}
        </span>
      ) : optionalText ? (
        <span className="ms-1 font-normal text-muted-foreground">{optionalText}</span>
      ) : null}
    </Label>
  );

  return (
    <div data-slot="form-field" data-invalid={error ? "" : undefined} className={cn("space-y-1.5", className)}>
      {layout === "inline" ? (
        <div className="flex min-h-11 items-center gap-3">
          {control}
          {labelNode}
        </div>
      ) : (
        <>
          {labelNode}
          {control}
        </>
      )}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
