"use client";

import * as SheetPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Side drawer (a Radix dialog). Sides are logical: `start` is the reading start
 * (right in Arabic, left in English) and `end` the other side; `bottom` suits phone
 * action sheets.
 */
export function Sheet(props: ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

export function SheetTrigger(props: ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

export function SheetClose(props: ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

const SIDES = {
  start:
    "inset-y-0 start-0 h-full w-[85%] max-w-sm border-e animate-slide-in-x-neg rtl:animate-slide-in-x-pos",
  end: "inset-y-0 end-0 h-full w-[85%] max-w-sm border-s animate-slide-in-x-pos rtl:animate-slide-in-x-neg",
  top: "inset-x-0 top-0 max-h-[85dvh] border-b animate-slide-in-y-neg",
  bottom: "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-xl border-t pb-[env(safe-area-inset-bottom)] animate-slide-in-y-pos",
} as const;

export function SheetContent({
  className,
  children,
  side = "end",
  closeLabel,
  ...props
}: ComponentProps<typeof SheetPrimitive.Content> & { side?: keyof typeof SIDES; closeLabel?: string }) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay data-slot="sheet-overlay" className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-overlay-in" />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn("fixed z-50 flex flex-col gap-4 overflow-y-auto bg-popover text-popover-foreground shadow-lg outline-none", SIDES[side], className)}
        {...props}
      >
        {children}
        {closeLabel ? (
          <SheetPrimitive.Close
            aria-label={closeLabel}
            className="absolute end-2 top-2 inline-flex size-11 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <XIcon aria-hidden="true" className="size-5" />
          </SheetPrimitive.Close>
        ) : null}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="sheet-header" className={cn("flex flex-col gap-1.5 p-4 pe-14", className)} {...props} />;
}

export function SheetFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="sheet-footer" className={cn("mt-auto flex flex-col gap-2 p-4", className)} {...props} />;
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title data-slot="sheet-title" className={cn("text-lg font-semibold", className)} {...props} />;
}

export function SheetDescription({ className, ...props }: ComponentProps<typeof SheetPrimitive.Description>) {
  return <SheetPrimitive.Description data-slot="sheet-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
