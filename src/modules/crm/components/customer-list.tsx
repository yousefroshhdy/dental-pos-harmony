import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";
import { Badge, Card, Input, Label, Select, Table, Td, Th } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { formatEgyptPhone, lifecycleTone, listQuery, localizedName, locationStatus } from "../logic";
import type { CustomerListParams } from "../schemas";
import { LIFECYCLE_STAGES, type CustomerListRow } from "../types";
import type { Option } from "./customer-form";

/** Search and filters as a plain GET form: works without JavaScript and keeps the URL shareable. */
export async function CustomerFilters({
  params,
  territories,
  specialties,
}: {
  params: CustomerListParams;
  territories: Option[];
  specialties: Option[];
}) {
  const t = await getTranslations("crm.list");
  const tStage = await getTranslations("crm.stage");
  const filtered = Boolean(params.q || params.stage || params.territory || params.specialty);

  return (
    <form method="get" role="search" className="grid gap-3 rounded-lg border bg-card p-3 sm:grid-cols-2 lg:grid-cols-5">
      <div className="space-y-1 sm:col-span-2 lg:col-span-2">
        <Label htmlFor="f-q">{t("search")}</Label>
        <Input id="f-q" name="q" type="search" defaultValue={params.q ?? ""} placeholder={t("searchPlaceholder")} maxLength={80} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="f-stage">{t("stage")}</Label>
        <Select id="f-stage" name="stage" defaultValue={params.stage ?? ""} className="w-full">
          <option value="">{t("all")}</option>
          {LIFECYCLE_STAGES.map((s) => (
            <option key={s} value={s}>
              {tStage(s)}
            </option>
          ))}
        </Select>
      </div>
      {territories.length > 0 ? (
        <div className="space-y-1">
          <Label htmlFor="f-territory">{t("territory")}</Label>
          <Select id="f-territory" name="territory" defaultValue={params.territory ?? ""} className="w-full">
            <option value="">{t("all")}</option>
            {territories.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      {specialties.length > 0 ? (
        <div className="space-y-1">
          <Label htmlFor="f-specialty">{t("specialty")}</Label>
          <Select id="f-specialty" name="specialty" defaultValue={params.specialty ?? ""} className="w-full">
            <option value="">{t("all")}</option>
            {specialties.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      <div className="flex gap-2 sm:col-span-2 lg:col-span-5">
        <button type="submit" className={buttonVariants()}>
          {t("apply")}
        </button>
        {filtered ? (
          <Link href="/customers" className={buttonVariants({ variant: "ghost" })}>
            {t("clear")}
          </Link>
        ) : null}
      </div>
    </form>
  );
}

const LOCATION_TONE = { verified: "success", unverified: "warning", missing: "neutral" } as const;

/** Cards on phones, a table from `md` up. */
export async function CustomerList({
  rows,
  locale,
  governorates,
  specialties,
}: {
  rows: CustomerListRow[];
  locale: string;
  governorates: Map<string, string>;
  specialties: Map<string, string>;
}) {
  const t = await getTranslations("crm.list");
  const tStage = await getTranslations("crm.stage");
  const tLoc = await getTranslations("crm.locationStatus");

  const place = (r: CustomerListRow) =>
    [r.city, r.governorate_code ? (governorates.get(r.governorate_code) ?? r.governorate_code) : null].filter(Boolean).join(locale === "ar" ? "، " : ", ");
  const rep = (r: CustomerListRow) => localizedName(locale, r.primary_rep_name_en, r.primary_rep_name_ar);

  return (
    <>
      <ul className="space-y-2 md:hidden">
        {rows.map((r) => {
          const loc = locationStatus(r);
          return (
            <li key={r.id}>
              <Link href={`/customers/${r.id}`} className="block rounded-lg focus-visible:outline-2 focus-visible:outline-ring">
                <Card className="space-y-1 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 font-medium break-words">{r.display_name}</span>
                    <Badge tone={lifecycleTone(r.lifecycle_stage)}>{tStage(r.lifecycle_stage)}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <span dir="ltr">{r.customer_no}</span>
                    {r.phone_primary ? (
                      <>
                        {" · "}
                        <span dir="ltr">{formatEgyptPhone(r.phone_primary)}</span>
                      </>
                    ) : null}
                  </p>
                  {place(r) ? <p className="text-sm">{place(r)}</p> : null}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {rep(r) ? <span>{t("repShort", { name: rep(r) })}</span> : null}
                    <Badge tone={LOCATION_TONE[loc]}>{tLoc(loc)}</Badge>
                  </div>
                </Card>
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="hidden md:block">
        <Table>
          <thead>
            <tr>
              <Th>{t("name")}</Th>
              <Th>{t("number")}</Th>
              <Th>{t("phone")}</Th>
              <Th>{t("place")}</Th>
              <Th>{t("specialty")}</Th>
              <Th>{t("stage")}</Th>
              <Th>{t("rep")}</Th>
              <Th>{t("location")}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const loc = locationStatus(r);
              return (
                <tr key={r.id} className="hover:bg-muted/50">
                  <Td className="min-w-48">
                    <Link href={`/customers/${r.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
                      {r.display_name}
                    </Link>
                    {r.doctor_name && r.doctor_name !== r.display_name ? (
                      <span className="block text-xs text-muted-foreground">{r.doctor_name}</span>
                    ) : null}
                  </Td>
                  <Td>
                    <span dir="ltr" className="whitespace-nowrap">
                      {r.customer_no}
                    </span>
                  </Td>
                  <Td>
                    <span dir="ltr" className="whitespace-nowrap">
                      {formatEgyptPhone(r.phone_primary) || "—"}
                    </span>
                  </Td>
                  <Td className="min-w-32">{place(r) || "—"}</Td>
                  <Td>{r.specialty_code ? (specialties.get(r.specialty_code) ?? r.specialty_code) : "—"}</Td>
                  <Td>
                    <Badge tone={lifecycleTone(r.lifecycle_stage)}>{tStage(r.lifecycle_stage)}</Badge>
                  </Td>
                  <Td className="min-w-32">{rep(r) || "—"}</Td>
                  <Td>
                    <Badge tone={LOCATION_TONE[loc]}>{tLoc(loc)}</Badge>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </div>
    </>
  );
}

/** Previous / next links that keep the current filters. */
export async function Pagination({
  params,
  totalPages,
  total,
}: {
  params: CustomerListParams;
  totalPages: number;
  total: number;
}) {
  const t = await getTranslations("crm.list");
  const base = { q: params.q, stage: params.stage, territory: params.territory, specialty: params.specialty };
  const prev = params.page > 1 ? `/customers${listQuery({ ...base, page: params.page - 1 })}` : null;
  const next = params.page < totalPages ? `/customers${listQuery({ ...base, page: params.page + 1 })}` : null;
  const link = (href: string | null, label: string, rel: string) =>
    href ? (
      <Link href={href} rel={rel} className={buttonVariants({ variant: "outline" })}>
        {label}
      </Link>
    ) : (
      <span aria-disabled="true" className={cn(buttonVariants({ variant: "outline" }), "pointer-events-none opacity-50")}>
        {label}
      </span>
    );

  return (
    <nav aria-label={t("pagination")} className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground">{t("pageOf", { page: params.page, pages: totalPages, total })}</p>
      <div className="flex gap-2">
        {link(prev, t("previous"), "prev")}
        {link(next, t("next"), "next")}
      </div>
    </nav>
  );
}
