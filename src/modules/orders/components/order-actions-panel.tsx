"use client";

import { MoreHorizontalIcon } from "lucide-react";
import { createContext, useRef, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { StickyActionBar } from "../kit/sticky-bar";

/**
 * One fulfilment idempotency key per order page, shared by every copy of the
 * fulfil form (the desktop card and the phone sheet, which unmounts when it
 * closes), so a retry after a lost answer always replays the same fulfilment.
 */
export const FulfilKeyContext = createContext<RefObject<string | null> | null>(null);

/**
 * The order's actions: a card beside the lines from `md` up; on phones a sticky
 * bar (the total and an "Actions" button) that opens them in a bottom sheet.
 * The forms are the same server-checked forms in both places.
 */
export function OrderActionsPanel({
  title,
  description,
  openLabel,
  closeLabel,
  summary,
  aboveBottomNav,
  children,
}: {
  title: string;
  description: string;
  openLabel: string;
  closeLabel: string;
  summary: ReactNode;
  aboveBottomNav: boolean;
  children: ReactNode;
}) {
  const fulfilKey = useRef<string | null>(null);
  return (
    <FulfilKeyContext.Provider value={fulfilKey}>
      <Card className="hidden space-y-4 md:block">
        <CardTitle>{title}</CardTitle>
        <div className="grid gap-3">{children}</div>
      </Card>
      <StickyActionBar aboveBottomNav={aboveBottomNav} className="md:hidden">
        <div className="min-w-0 flex-1 text-sm">{summary}</div>
        <Sheet>
          <SheetTrigger asChild>
            <Button size="lg">
              <MoreHorizontalIcon aria-hidden="true" />
              {openLabel}
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" closeLabel={closeLabel}>
            <SheetHeader>
              <SheetTitle>{title}</SheetTitle>
              <SheetDescription>{description}</SheetDescription>
            </SheetHeader>
            <div className="grid gap-3 px-4 pb-4">{children}</div>
          </SheetContent>
        </Sheet>
      </StickyActionBar>
    </FulfilKeyContext.Provider>
  );
}
