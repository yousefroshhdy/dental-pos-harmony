import { getTranslations, setRequestLocale } from "next-intl/server";
import { Badge, Card, CardTitle } from "@/components/ui/primitives";
import { getUserContext } from "@/lib/authz/context";

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  const t = await getTranslations("home");
  const tScopes = await getTranslations("scopes");

  const name = (locale === "ar" ? ctx.employee?.full_name_ar : null) ?? ctx.employee?.full_name_en ?? "";
  const permissions = Object.entries(ctx.permissions).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("greeting", { name })}</h1>

      {permissions.length === 0 && !ctx.is_owner ? <Card className="text-sm text-muted-foreground">{t("noRoles")}</Card> : null}

      <Card className="space-y-3">
        <CardTitle>{t("yourAccess")}</CardTitle>
        {ctx.is_owner ? <Badge tone="info">{t("owner")}</Badge> : null}
        <p className="text-sm text-muted-foreground">{t("permissionCount", { count: permissions.length })}</p>
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {permissions.map(([code, grant]) => (
            <li key={code} className="flex items-center justify-between gap-2 rounded-md bg-muted px-2 py-1">
              <code dir="ltr" className="truncate">
                {code}
              </code>
              <span className="flex gap-1">
                <Badge>{tScopes(grant.scope)}</Badge>
                {grant.limit !== null ? <Badge tone="warning">≤ {Number(grant.limit)}</Badge> : null}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
