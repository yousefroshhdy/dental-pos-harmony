import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { Forbidden } from "@/components/forbidden";
import { FilterChips } from "@/components/page-kit/filter-chips";
import { ListError } from "@/components/page-kit/list-error";
import { readTableParams } from "@/components/ui/data-table-params";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/authz/can";
import { getUserContext } from "@/lib/authz/context";
import { pickParam } from "@/lib/list-query";
import { SecurityEventsTable, type SecurityEventListRow } from "@/modules/admin/components/security-events-table";
import { CAIRO_DATE_TIME } from "@/modules/admin/format";
import { localizedName, severityTone } from "@/modules/admin/logic";
import { listSecurityEventsPage, listUsersByIds } from "@/modules/admin/queries";
import { SECURITY_EVENTS_TABLE, SEVERITIES } from "@/modules/admin/tables";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.security" });
  return { title: t("title") };
}

export default async function SecurityEventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const ctx = await getUserContext();
  if (!can(ctx, "audit.security.read")) return <Forbidden />;

  const t = await getTranslations("admin.security");
  const tx = await getTranslations("setup.console");
  const format = await getFormatter();
  const sp = await searchParams;
  const table = readTableParams(sp, SECURITY_EVENTS_TABLE);
  const severity = pickParam(sp, "severity", [...SEVERITIES, "all"] as const, "all");

  const events = await listSecurityEventsPage({
    offset: table.offset,
    pageSize: table.pageSize,
    orderBy: table.sorting[0]?.id ?? "occurred_at",
    desc: table.sorting[0]?.desc ?? true,
    search: table.search,
    severity: severity === "all" ? null : severity,
  });
  const pageRows = events.ok ? events.data.rows : [];

  // Names are a convenience: without admin.user.read the actor column falls back to a short id.
  const actorIds = [...new Set(pageRows.map((e) => e.user_id).filter((id): id is string => id !== null))];
  const users = can(ctx, "admin.user.read") ? await listUsersByIds(actorIds) : null;
  const names = new Map(
    (users?.ok ? users.data : []).map((u) => [u.user_id, localizedName(locale, u.full_name_en, u.full_name_ar) || u.email || ""]),
  );
  const actor = (userId: string | null) => (userId ? names.get(userId) || userId.slice(0, 8) : t("system"));
  const typeName = (type: string) => (t.has(`types.${type}`) ? t(`types.${type}`) : type);

  const rows: SecurityEventListRow[] = pageRows.map((e) => ({
    id: e.id,
    occurredAt: e.occurred_at,
    when: format.dateTime(new Date(e.occurred_at), CAIRO_DATE_TIME),
    type: e.event_type,
    typeLabel: typeName(e.event_type),
    severity: e.severity,
    severityTone: severityTone(e.severity),
    actor: actor(e.user_id),
    details: JSON.stringify(e.details ?? {}, null, 2),
  }));

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={tx("securityIntro")} />
      <SecurityEventsTable
        rows={rows}
        rowCount={events.ok ? events.data.total : 0}
        error={events.ok ? undefined : <ListError error={events.error} />}
        filters={
          <FilterChips
            label={tx("filterSeverity")}
            pathname="/admin/security"
            params={sp}
            param="severity"
            current={severity === "all" ? null : severity}
            options={[{ value: null, label: tx("all") }, ...SEVERITIES.map((s) => ({ value: s, label: t(`severities.${s}`) }))]}
          />
        }
      />
    </div>
  );
}
