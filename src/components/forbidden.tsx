import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";

/**
 * Shown when the signed-in user lacks the permission a page needs. This is a
 * courtesy: the data itself is protected by RLS whether or not this renders.
 */
export async function Forbidden() {
  const t = await getTranslations("admin.forbidden");
  const nav = await getTranslations("nav");
  return (
    <Card role="alert" className="mx-auto max-w-md space-y-3 text-center">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("body")}</p>
      <Link href="/" className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
        {nav("home")}
      </Link>
    </Card>
  );
}
