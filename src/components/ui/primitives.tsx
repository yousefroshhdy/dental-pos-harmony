import * as LabelPrimitive from "@radix-ui/react-label";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "flex min-h-11 w-full rounded-md border bg-card px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn("min-h-11 rounded-md border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn("text-sm font-medium", className)} {...props} />;
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-lg border bg-card p-4 shadow-sm sm:p-6", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("text-lg font-semibold", className)} {...props} />;
}

const badgeTones = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success/15 text-success",
  warning: "bg-warning/20 text-foreground",
  danger: "bg-destructive/15 text-destructive",
  info: "bg-primary/15 text-primary",
} as const;

export function Badge({ tone = "neutral", className, ...props }: ComponentProps<"span"> & { tone?: keyof typeof badgeTones }) {
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", badgeTones[tone], className)} {...props} />;
}

export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border bg-card">
      <table className={cn("w-full text-sm", className)} {...props} />
    </div>
  );
}
export function Th({ className, ...props }: ComponentProps<"th">) {
  return <th className={cn("border-b bg-muted px-3 py-2 text-start font-medium whitespace-nowrap", className)} {...props} />;
}
export function Td({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("border-b px-3 py-2 align-middle", className)} {...props} />;
}

export function Alert({ tone = "danger", className, ...props }: ComponentProps<"div"> & { tone?: "danger" | "info" | "success" }) {
  const tones = { danger: "border-destructive/40 bg-destructive/10", info: "border-primary/40 bg-primary/10", success: "border-success/40 bg-success/10" };
  return <div role="alert" className={cn("rounded-md border px-3 py-2 text-sm", tones[tone], className)} {...props} />;
}
