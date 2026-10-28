import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { Badge, Table, Td, Th } from "@/components/ui/primitives";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { ErrorMessage } from "@/modules/admin/components/action-message";
import { CAIRO_DATE_TIME } from "@/modules/admin/format";
import { localizedName, severityTone } from "@/modules/admin/logic";
import { listSecurityEvents, listUsers } from "@/modules/admin/queries";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.security" });
  return { title: t("title") };
}

const LIMIT = 200;

export default async function SecurityEventsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "audit.security.read")) return <Forbidden />;

  const t = await getTranslations("admin.security");
  const format = await getFormatter();

  // Names are a convenience: without admin.user.read the actor column falls back to a short id.
  const [events, users] = await Promise.all([
    listSecurityEvents(LIMIT),
    can(ctx, "admin.user.read") ? listUsers() : Promise.resolve(null),
  ]);
  if (!events.ok) return <ErrorMessage messageKey={events.error.messageKey} requestId={events.error.requestId} />;

  const names = new Map(
    (users?.ok ? users.data : []).map((u) => [u.user_id, localizedName(locale, u.full_name_en, u.full_name_ar) || u.email || ""]),
  );
  const actor = (userId: string | null) => (userId ? names.get(userId) || userId.slice(0, 8) : t("system"));
  const typeName = (type: string) => (t.has(`types.${type}`) ? t(`types.${type}`) : type);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("latest", { count: LIMIT })}</p>
      </div>

      {events.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>{t("when")}</Th>
              <Th>{t("event")}</Th>
              <Th>{t("severity")}</Th>
              <Th>{t("actor")}</Th>
              <Th>{t("details")}</Th>
            </tr>
          </thead>
          <tbody>
            {events.data.map((event) => (
              <tr key={event.id}>
                <Td className="whitespace-nowrap">
                  <time dateTime={event.occurred_at}>{format.dateTime(new Date(event.occurred_at), CAIRO_DATE_TIME)}</time>
                </Td>
                <Td className="min-w-40">
                  {typeName(event.event_type)}
                  <code dir="ltr" className="block text-xs text-muted-foreground">
                    {event.event_type}
                  </code>
                </Td>
                <Td>
                  <Badge tone={severityTone(event.severity)}>{t(`severities.${event.severity}`)}</Badge>
                </Td>
                <Td className="min-w-32">{actor(event.user_id)}</Td>
                <Td className="min-w-48">
                  <details>
                    <summary className="inline-flex min-h-11 cursor-pointer items-center text-primary">{t("show")}</summary>
                    <pre dir="ltr" className="mt-1 max-w-md overflow-x-auto rounded-md bg-muted p-2 text-start text-xs whitespace-pre-wrap break-all">
                      {JSON.stringify(event.details ?? {}, null, 2)}
                    </pre>
                  </details>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
