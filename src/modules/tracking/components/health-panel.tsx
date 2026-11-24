import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Alert, Badge, Table, Td, Th } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { Empty, Item, ItemList, Section } from "@/modules/field/components/layout-bits";
import { localizedName } from "@/modules/field/logic";
import { CAIRO_TIME } from "../format";
import { ageMinutes, DEVICE_PERMISSIONS, healthNow, needsAttention, shiftState, sortHealthRows } from "../health";
import { trackingErrorCode } from "../logic";
import { getTrackingHealth } from "../queries";
import type { HealthRow } from "../types";

/**
 * The managers' tracking health panel (Phase P step 5), on the team view. One row per rep in
 * the caller's D-14 scope (api.v_tracking_health): shift open or closed and since when, the
 * last point (time, age, collector), what the phone last reported about itself (location
 * permission, app version or web build, battery saver), and an attention badge when a shift
 * is open but nothing arrived for more than 15 minutes. "Now" is the server's clock of the read.
 * No coordinates: positions stay on the day page and the team map.
 */
export async function TrackingHealthPanel() {
  const t = await getTranslations("tracking");
  const tErrors = await getTranslations("errors");
  const format = await getFormatter();
  const lang = await getLocale();

  const result = await getTrackingHealth();
  const now = healthNow(result.ok ? result.data : []);
  const rows = result.ok ? sortHealthRows(result.data, lang, now) : [];
  const attention = rows.filter((r) => needsAttention(r, now)).length;

  const name = (r: HealthRow) => localizedName(lang, r.full_name_en, r.full_name_ar);
  const time = (iso: string | null) => (iso ? format.dateTime(new Date(iso), CAIRO_TIME) : null);
  const age = (iso: string | null) => {
    const m = ageMinutes(iso, now);
    return m === null ? null : t("health.ago", { minutes: m });
  };

  const shift = (r: HealthRow) => {
    const state = shiftState(r);
    if (state === "never") return <Badge>{t("health.shiftNever")}</Badge>;
    const since = time(r.shift_since);
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <Badge tone={state === "open" ? "success" : "neutral"}>{t(`health.shift.${state}`)}</Badge>
        {since ? <span className="text-xs text-muted-foreground">{t(state === "open" ? "health.since" : "health.endedAt", { time: since })}</span> : null}
      </span>
    );
  };
  const lastPoint = (r: HealthRow) =>
    r.last_point_at ? (
      <span>
        {time(r.last_point_at)} <span className="text-xs text-muted-foreground">({age(r.last_point_received_at ?? r.last_point_at)})</span>
      </span>
    ) : (
      t("health.noPoint")
    );
  const source = (r: HealthRow) => {
    const s = r.device_source ?? r.last_point_source;
    return s ? t(`health.source.${s}`) : t("health.notReported");
  };
  const permission = (r: HealthRow) => {
    const p = r.device_permission;
    if (!p || !(DEVICE_PERMISSIONS as readonly string[]).includes(p)) return <span className="text-muted-foreground">{t("health.notReported")}</span>;
    const tone = p === "granted" ? "success" : p === "denied" || p === "services_off" ? "danger" : "neutral";
    return <Badge tone={tone}>{t(`health.permission.${p}`)}</Badge>;
  };
  const version = (r: HealthRow) =>
    r.device_app_version
      ? t("health.appVersion", { version: r.device_app_version })
      : r.device_web_build
        ? t("health.webBuild", { build: r.device_web_build })
        : t("health.notReported");
  const battery = (r: HealthRow) =>
    r.device_battery_saver === null ? t("health.notReported") : r.device_battery_saver ? t("health.batteryOn") : t("health.batteryOff");
  const reported = (r: HealthRow) => (r.device_reported_at ? t("health.reported", { ago: age(r.device_reported_at) ?? "" }) : t("health.neverReported"));
  const pending = (r: HealthRow) =>
    r.device_pending_points && r.device_pending_points > 0 ? t("health.pending", { count: r.device_pending_points }) : null;
  const badge = (r: HealthRow) =>
    needsAttention(r, now) ? (
      <Badge tone="danger" title={t("health.attentionHint")}>
        {t("health.attention")}
      </Badge>
    ) : null;

  return (
    <Section title={t("health.title")} count={rows.length}>
      <p className="text-sm text-muted-foreground">{t("health.subtitle")}</p>
      {!result.ok ? (
        <Alert>
          {trackingErrorCode(result.error.code)
            ? t(`errors.${trackingErrorCode(result.error.code)}`)
            : tErrors(result.error.messageKey, { requestId: result.error.requestId ?? "—" })}
        </Alert>
      ) : rows.length === 0 ? (
        <Empty>{t("health.empty")}</Empty>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {t("health.attentionCount", { count: attention })} · {t("health.checkedAt", { time: format.dateTime(new Date(now), CAIRO_TIME) })}
          </p>

          {/* Phones: one card per rep. */}
          <ItemList className="md:hidden">
            {rows.map((r) => (
              <Item key={r.employee_id} className={cn(needsAttention(r, now) && "border-destructive bg-destructive/5")}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="font-medium break-words">{name(r)}</span>
                  {badge(r)}
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">{t("health.col.shift")}</dt>
                  <dd>{shift(r)}</dd>
                  <dt className="text-muted-foreground">{t("health.col.lastPoint")}</dt>
                  <dd>{lastPoint(r)}</dd>
                  <dt className="text-muted-foreground">{t("health.col.source")}</dt>
                  <dd>{source(r)}</dd>
                  <dt className="text-muted-foreground">{t("health.col.permission")}</dt>
                  <dd>{permission(r)}</dd>
                  <dt className="text-muted-foreground">{t("health.col.version")}</dt>
                  <dd dir="ltr" className="text-start break-all">{version(r)}</dd>
                  <dt className="text-muted-foreground">{t("health.col.battery")}</dt>
                  <dd>{battery(r)}</dd>
                </dl>
                <p className="text-xs text-muted-foreground">
                  {reported(r)}
                  {pending(r) ? ` · ${pending(r)}` : ""}
                </p>
              </Item>
            ))}
          </ItemList>

          {/* Wider screens: the table. */}
          <div className="hidden md:block">
            <Table>
              <thead>
                <tr>
                  <Th scope="col">{t("team.rep")}</Th>
                  <Th scope="col">{t("health.col.shift")}</Th>
                  <Th scope="col">{t("health.col.lastPoint")}</Th>
                  <Th scope="col">{t("health.col.source")}</Th>
                  <Th scope="col">{t("health.col.permission")}</Th>
                  <Th scope="col">{t("health.col.version")}</Th>
                  <Th scope="col">{t("health.col.battery")}</Th>
                  <Th scope="col">{t("health.col.reported")}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.employee_id} className={cn(needsAttention(r, now) && "bg-destructive/5")}>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="font-medium">{name(r)}</span>
                        {badge(r)}
                      </div>
                    </Td>
                    <Td>{shift(r)}</Td>
                    <Td className="whitespace-nowrap">{lastPoint(r)}</Td>
                    <Td>{source(r)}</Td>
                    <Td>{permission(r)}</Td>
                    <Td dir="ltr" className="text-start">
                      {version(r)}
                    </Td>
                    <Td>{battery(r)}</Td>
                    <Td className="text-xs text-muted-foreground">
                      {reported(r)}
                      {pending(r) ? <div>{pending(r)}</div> : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </>
      )}
    </Section>
  );
}
