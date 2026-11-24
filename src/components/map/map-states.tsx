import { cn } from "@/lib/utils";

/**
 * A map-sized box with a message: "The map is not available yet" (no network call is made) and
 * similar states. Same footprint as the map so the page does not jump. `detail` is the optional
 * technical line shown only to the owner/admin.
 */
export function MapStateBox({
  title,
  body,
  detail,
  tone = "info",
  className,
}: {
  title: string;
  body: string;
  detail?: string;
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
        {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      </div>
    </div>
  );
}
