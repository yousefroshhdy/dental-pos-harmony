import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";
import { Alert, Badge } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";

/**
 * Tells the viewer their reads are logged, shows which categories are hidden, and offers
 * the reveal (a GET form, so it is a deliberate, logged request — never a prefetch).
 */
export async function AccessNotice({
  maskedCategories,
  canReveal,
  revealed,
  hiddenInputs,
  hideHref,
  canSeeSecurityLog,
}: {
  maskedCategories: string[];
  canReveal: boolean;
  revealed: boolean;
  hiddenInputs: Record<string, string | number | boolean | undefined>;
  hideHref: string;
  canSeeSecurityLog: boolean;
}) {
  const t = await getTranslations("audit");
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {t("accessNotice")}{" "}
        {canSeeSecurityLog ? (
          <Link href="/admin/security" prefetch={false} className="text-primary underline-offset-4 hover:underline">
            {t("securityLink")}
          </Link>
        ) : null}
      </p>

      {revealed ? (
        <Alert tone="info" role="status" className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span>{t("reveal.active")}</span>
          <Link href={hideHref} prefetch={false} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {t("reveal.hide")}
          </Link>
        </Alert>
      ) : maskedCategories.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <span>{t("reveal.maskedNotice")}</span>
            {maskedCategories.map((c) => (
              <Badge key={c} tone="warning">
                {t.has(`categories.${c}`) ? t(`categories.${c}`) : t("categories.other")}
              </Badge>
            ))}
          </div>
          {canReveal ? (
            <form method="get" className="flex flex-col gap-1 sm:items-end">
              {Object.entries(hiddenInputs).map(([name, value]) =>
                value === undefined || value === false || value === "" ? null : (
                  <input key={name} type="hidden" name={name} value={value === true ? "1" : String(value)} />
                ),
              )}
              <input type="hidden" name="reveal" value="1" />
              <button type="submit" className={buttonVariants({ variant: "outline" })}>
                {t("reveal.show")}
              </button>
              <span className="text-xs text-muted-foreground">{t("reveal.note")}</span>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
