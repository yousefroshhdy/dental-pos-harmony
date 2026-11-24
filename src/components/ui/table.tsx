import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Table markup. `Table` wraps the <table> in a horizontally scrolling card so a wide
 * table never scrolls the page (360 px rule). `Th` / `Td` are the pre-Phase-P names;
 * TableHead / TableCell are the shadcn ones and render the same cells.
 */
export function Table({ className, containerClassName, ...props }: ComponentProps<"table"> & { containerClassName?: string }) {
  return (
    <div data-slot="table-container" className={cn("relative w-full overflow-x-auto rounded-lg border bg-card", containerClassName)}>
      <table data-slot="table" className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn(className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child>td]:border-b-0", className)} {...props} />;
}

export function TableFooter({ className, ...props }: ComponentProps<"tfoot">) {
  return <tfoot data-slot="table-footer" className={cn("bg-muted/60 font-medium", className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr data-slot="table-row" className={cn("transition-colors hover:bg-muted/40 data-[state=selected]:bg-muted", className)} {...props} />;
}

export function Th({ className, ...props }: ComponentProps<"th">) {
  return <th data-slot="table-head" className={cn("border-b bg-muted px-3 py-2 text-start font-medium whitespace-nowrap", className)} {...props} />;
}

export function Td({ className, ...props }: ComponentProps<"td">) {
  return <td data-slot="table-cell" className={cn("border-b px-3 py-2 align-middle", className)} {...props} />;
}

export const TableHead = Th;
export const TableCell = Td;

export function TableCaption({ className, ...props }: ComponentProps<"caption">) {
  return <caption data-slot="table-caption" className={cn("mt-3 text-sm text-muted-foreground", className)} {...props} />;
}
