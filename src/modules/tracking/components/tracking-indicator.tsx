"use client";

import { MapPinOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { useNativeShell, useTrackingCollector } from "../use-tracking";

/**
 * Header: the app-wide location collector and its "Tracking on" indicator (D-14).
 * Mounted once by the app layout for users who may start a shift:
 *
 *   <TrackingIndicator userId={ctx.user_id} enabled={can(ctx, "field.shift.start")} />
 *
 * It renders nothing and collects nothing while no shift is open. While one is
 * open it stays visible on every page, and tapping it opens the rep's day.
 */
export function TrackingIndicator({ userId, enabled }: { userId: string; enabled: boolean }) {
  const t = useTranslations("tracking.indicator");
  const state = useTrackingCollector(userId, enabled);
  const native = useNativeShell();
  if (!enabled || !state.shift) return null;

  const problem = state.problem !== null;
  const pending = !state.shift.confirmed;
  const minutes = String(Math.round(state.intervalS / 60));
  const label = problem ? t("problem") : pending ? t("pending") : native ? t("labelNative", { minutes }) : t("label", { minutes });

  return (
    <Link
      href="/today"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap",
        problem ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-success/40 bg-success/10 text-success",
      )}
    >
      <span className="relative inline-flex size-2" aria-hidden="true">
        {!problem ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none" /> : null}
        <span className={cn("relative inline-flex size-2 rounded-full", problem ? "bg-destructive" : "bg-success")} />
      </span>
      {problem ? <MapPinOff aria-hidden="true" className="size-4" /> : null}
      <span aria-hidden="true">{t("on")}</span>
    </Link>
  );
}
