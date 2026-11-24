"use client";

import { CalendarIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { TZDate } from "react-day-picker";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Calendar } from "./calendar";
import { CAIRO_TZ, cairoIsoDate, formatIsoDate, parseIsoDate } from "./date-utils";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export interface DatePickerProps {
  /** `YYYY-MM-DD` on the Cairo calendar, or null. */
  value: string | null;
  onChange: (value: string | null) => void;
  lang: "ar" | "en";
  placeholder: string;
  /** Accessible name of the clear button; omit to hide it. */
  clearLabel?: string;
  /** Form field name: a hidden input carries the ISO date for server actions. */
  name?: string;
  id?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  invalid?: boolean;
  "aria-describedby"?: string;
  className?: string;
}

const toDate = (iso: string | null): Date | undefined => {
  const p = parseIsoDate(iso);
  return p ? new TZDate(p.year, p.month - 1, p.day, CAIRO_TZ) : undefined;
};

/**
 * One calendar date in a popover. Values are ISO strings on the Cairo calendar so
 * they go straight into api.* parameters (`p_planned_for`, `p_due_date`, …).
 */
export function DatePicker({
  value,
  onChange,
  lang,
  placeholder,
  clearLabel,
  name,
  id,
  min,
  max,
  disabled,
  invalid,
  className,
  ...rest
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const selected = toDate(value);
  const minDate = toDate(min ?? null);
  const maxDate = toDate(max ?? null);
  const disabledDays = [...(minDate ? [{ before: minDate }] : []), ...(maxDate ? [{ after: maxDate }] : [])];

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={rest["aria-describedby"]}
            className={cn("flex-1 justify-start px-3 font-normal", !value && "text-muted-foreground")}
          >
            <CalendarIcon aria-hidden="true" className="opacity-60" />
            <span className="truncate">{value ? formatIsoDate(value, lang) : placeholder}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            lang={lang}
            mode="single"
            selected={selected}
            defaultMonth={selected}
            disabled={disabledDays}
            onSelect={(date) => {
              onChange(date ? cairoIsoDate(date) : null);
              setOpen(false);
            }}
            autoFocus
          />
        </PopoverContent>
      </Popover>
      {clearLabel && value && !disabled ? (
        <Button type="button" variant="ghost" size="icon" aria-label={clearLabel} onClick={() => onChange(null)}>
          <XIcon aria-hidden="true" />
        </Button>
      ) : null}
      {name ? <input type="hidden" name={name} value={value ?? ""} /> : null}
    </div>
  );
}
