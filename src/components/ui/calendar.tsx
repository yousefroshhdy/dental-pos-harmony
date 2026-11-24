"use client";

import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { DayPicker, getDefaultClassNames } from "react-day-picker";
import { arEG, enUS } from "react-day-picker/locale";
import { cn } from "@/lib/utils";
import { buttonVariants } from "./button";
import { CAIRO_TZ } from "./date-utils";

const CHEVRONS = { left: ChevronLeftIcon, right: ChevronRightIcon, up: ChevronUpIcon, down: ChevronDownIcon } as const;

function Chevron({ orientation = "left", className }: { orientation?: keyof typeof CHEVRONS; className?: string }) {
  const Icon = CHEVRONS[orientation];
  return <Icon aria-hidden="true" className={cn("size-4", className)} />;
}

/**
 * Month calendar (react-day-picker). Defaults for Honest OS: the Egyptian Arabic or
 * US English locale from `lang`, the page direction, the Cairo time zone (so
 * "today" is Cairo's today) and Western digits (D-11). Day buttons are 44 px.
 */
export function Calendar({
  lang,
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: ComponentProps<typeof DayPicker> & { lang: "ar" | "en" }) {
  const defaults = getDefaultClassNames();
  return (
    <DayPicker
      locale={lang === "ar" ? arEG : enUS}
      dir={lang === "ar" ? "rtl" : "ltr"}
      numerals="latn"
      timeZone={CAIRO_TZ}
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        root: cn("w-fit", defaults.root),
        months: cn("relative flex flex-col gap-4 sm:flex-row", defaults.months),
        month: cn("flex w-full flex-col gap-3", defaults.month),
        nav: cn("absolute inset-x-0 top-0 flex w-full items-center justify-between", defaults.nav),
        button_previous: cn(buttonVariants({ variant: "ghost", size: "icon" }), "aria-disabled:opacity-50", defaults.button_previous),
        button_next: cn(buttonVariants({ variant: "ghost", size: "icon" }), "aria-disabled:opacity-50", defaults.button_next),
        month_caption: cn("flex h-11 w-full items-center justify-center px-12", defaults.month_caption),
        caption_label: cn("text-sm font-medium", defaults.caption_label),
        month_grid: cn("w-full border-collapse", defaults.month_grid),
        weekdays: cn("flex", defaults.weekdays),
        weekday: cn("w-11 text-[0.75rem] font-normal text-muted-foreground", defaults.weekday),
        week: cn("mt-1 flex w-full", defaults.week),
        day: cn("relative size-11 p-0 text-center text-sm", defaults.day),
        day_button: cn(
          "inline-flex size-11 items-center justify-center rounded-md tabular-nums outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
          defaults.day_button,
        ),
        selected: cn("[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary", defaults.selected),
        today: cn("[&>button]:font-semibold [&>button]:ring-1 [&>button]:ring-highlight", defaults.today),
        outside: cn("text-muted-foreground opacity-60", defaults.outside),
        disabled: cn("text-muted-foreground opacity-40", defaults.disabled),
        hidden: cn("invisible", defaults.hidden),
        ...classNames,
      }}
      components={{ Chevron }}
      {...props}
    />
  );
}
