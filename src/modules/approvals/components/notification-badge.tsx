import { Bell } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { badgeCount } from "../logic";
import { countUnreadNotifications } from "../queries";

/**
 * Header bell with the caller's unread notification count, linking to
 * /notifications. A server component for the app layout header (mount it next
 * to the locale switcher). A failed count renders the bell without a number.
 */
export async function NotificationBadge() {
  const t = await getTranslations("approvals.notifications");
  const count = await countUnreadNotifications();
  const unread = count.ok ? count.data : 0;
  const text = badgeCount(unread);
  return (
    <Link
      href="/notifications"
      aria-label={text ? t("badgeLabel", { count: unread }) : t("badgeLabelNone")}
      className="relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-muted"
    >
      <Bell className="size-5" aria-hidden="true" />
      {text ? (
        <span className="absolute end-1 top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[0.625rem] leading-5 font-semibold text-destructive-foreground">
          {text}
        </span>
      ) : null}
    </Link>
  );
}
