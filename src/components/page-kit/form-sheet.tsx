"use client";

import { PlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * A "New …" button that opens its form in a side sheet (a bottom sheet would hide
 * the keyboard's fields on a phone, so it slides from the reading-direction end and
 * takes the full width there). The form itself is the server-rendered `children`.
 */
export function FormSheet({
  trigger,
  title,
  description,
  closeLabel,
  variant = "default",
  icon = <PlusIcon aria-hidden="true" />,
  children,
}: {
  trigger: string;
  title: string;
  description?: string;
  closeLabel: string;
  variant?: ButtonProps["variant"];
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant={variant}>
          {icon}
          {trigger}
        </Button>
      </SheetTrigger>
      <SheetContent side="end" closeLabel={closeLabel} className="w-full p-4 sm:max-w-lg sm:p-6">
        <SheetHeader className="pe-10">
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}
