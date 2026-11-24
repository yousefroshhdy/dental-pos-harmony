"use client";

import { useLocale } from "next-intl";
import { useState } from "react";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { DatePicker } from "@/components/ui/date-picker";

/**
 * Uncontrolled wrappers so a server-rendered form (a GET filter form or a Server
 * Action form) can use the DatePicker and the Combobox: each keeps its own value
 * and submits it through a hidden input named `name`. FormField passes id and the
 * aria attributes through.
 */
export function FormDatePicker({
  name,
  defaultValue,
  placeholder,
  clearLabel,
  min,
  max,
  id,
  disabled,
  ...rest
}: {
  name: string;
  defaultValue?: string | null;
  placeholder: string;
  clearLabel?: string;
  min?: string;
  max?: string;
  id?: string;
  disabled?: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const locale = useLocale();
  const [value, setValue] = useState<string | null>(defaultValue ?? null);
  return (
    <DatePicker
      id={id}
      name={name}
      value={value}
      onChange={setValue}
      lang={locale === "en" ? "en" : "ar"}
      placeholder={placeholder}
      clearLabel={clearLabel}
      min={min}
      max={max}
      disabled={disabled}
      invalid={rest["aria-invalid"]}
      aria-describedby={rest["aria-describedby"]}
    />
  );
}

export function FormCombobox({
  name,
  options,
  defaultValue,
  placeholder,
  searchPlaceholder,
  emptyText,
  id,
  disabled,
  ...rest
}: {
  name: string;
  options: readonly ComboboxOption[];
  defaultValue?: string | null;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  id?: string;
  disabled?: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const [value, setValue] = useState<string | null>(defaultValue || null);
  return (
    <Combobox
      id={id}
      name={name}
      options={options}
      value={value}
      onValueChange={setValue}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
      disabled={disabled}
      invalid={rest["aria-invalid"]}
      aria-describedby={rest["aria-describedby"]}
    />
  );
}
