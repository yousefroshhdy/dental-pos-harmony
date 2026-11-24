import { cn } from "@/lib/utils";

/**
 * A map-sized box with a message: "Map key not configured" (no network call is made) and
 * similar states. Same footprint as the map so the page does not jump.
 */
export function MapStateBox({
  title,
  body,
  tone = "info",
  className,
}: {
  title: string;
  body: string;
  tone?: "info" | "danger";
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "grid place-items-center rounded-lg border border-dashed p-4 text-center",
        tone === "danger" ? "border-destructive/50 bg-destructive/5" : "bg-muted/40",
        className ?? "h-[60vh] min-h-72 w-full",
      )}
    >
      <div className="max-w-sm space-y-1">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
