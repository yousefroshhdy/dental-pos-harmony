"use client";

import { CircleAlertIcon, MapPinOffIcon, PhoneOffIcon, SlidersHorizontalIcon, UsersIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useTransition, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { NativeSelect } from "@/components/ui/native-select";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useUrlTableState } from "@/components/ui/use-url-table-state";
import { Link, useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { EGP } from "../format";
import {
  activeCustomerFilters,
  CUSTOMER_SORTS,
  customerGaps,
  customerListHref,
  formatEgyptPhone,
  lifecycleTone,
  localizedName,
  locationStatus,
  PAGE_SIZE,
  toNumber,
  type CustomerFilterKey,
} from "../logic";
import type { CustomerListParams } from "../schemas";
import { LIFECYCLE_STAGES, type CustomerListRow } from "../types";
import { GapBadges } from "./gap-badges";

export interface FilterOption {
  value: string;
  label: string;
}

const LOCATION_TONE = { verified: "success", unverified: "warning", missing: "neutral" } as const;
const TABLE_OPTIONS = { pageSize: PAGE_SIZE, sortable: CUSTOMER_SORTS, defaultSort: { id: "display_name", desc: false } } as const;

/**
 * The customers list: DataTable in server mode (search, sort and page live in the URL and the
 * server page fetches one page from api.v_customer_list), filters as links/selects that also
 * live in the URL, a table from `md` and one card per customer on phones.
 */
export function CustomerTable({
  rows,
  total,
  params,
  locale,
  territories,
  specialties,
  reps,
  governorates,
  actions,
  error,
}: {
  rows: CustomerListRow[];
  total: number;
  params: CustomerListParams & { sort?: string };
  locale: string;
  territories: FilterOption[];
  specialties: FilterOption[];
  reps: FilterOption[];
  governorates: Record<string, string>;
  actions?: ReactNode;
  error?: ReactNode;
}) {
  const t = useTranslations("crm.list");
  const tStage = useTranslations("crm.stage");
  const tLoc = useTranslations("crm.locationStatus");
  const format = useFormatter();
  const url = useUrlTableState(TABLE_OPTIONS);
  const router = useRouter();
  const [filtering, startFiltering] = useTransition();
  const active = activeCustomerFilters(params);

  const go = (change: Partial<Record<CustomerFilterKey, string | undefined>> | null) =>
    startFiltering(() => router.replace(customerListHref(params, change), { scroll: false }));

  const place = (r: CustomerListRow) =>
    [r.city, r.governorate_code ? (governorates[r.governorate_code] ?? r.governorate_code) : null]
      .filter(Boolean)
      .join(locale === "ar" ? "، " : ", ");
  const rep = (r: CustomerListRow) => localizedName(locale, r.primary_rep_name_en, r.primary_rep_name_ar);
  const balance = (r: CustomerListRow) => {
    const value = toNumber(r.balance);
    // NULL = masked (no crm.customer_balance.read for this customer).
    return value === null ? null : format.number(value, EGP);
  };
  const overdueBadge = (r: CustomerListRow) =>
    r.is_overdue ? (
      <Badge variant="danger">
        <CircleAlertIcon aria-hidden="true" />
        {t("overdue")}
      </Badge>
    ) : null;

  const columns: DataTableColumn<CustomerListRow>[] = [
    {
      id: "display_name",
      header: t("name"),
      accessor: (r) => r.display_name,
      sortable: true,
      primary: true,
      className: "min-w-48",
      cell: (r) => (
        <span className="inline-flex flex-col gap-0.5">
          <span>{r.display_name}</span>
          {r.doctor_name && r.doctor_name !== r.display_name ? (
            <span className="text-xs font-normal text-muted-foreground">{r.doctor_name}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "customer_no",
      header: t("number"),
      accessor: (r) => r.customer_no,
      sortable: true,
      cell: (r) => (
        <span dir="ltr" className="whitespace-nowrap">
          {r.customer_no}
        </span>
      ),
    },
    {
      id: "phone",
      header: t("phone"),
      cell: (r) =>
        r.phone_primary ? (
          <span dir="ltr" className="whitespace-nowrap">
            {formatEgyptPhone(r.phone_primary)}
          </span>
        ) : (
          <GapBadges gaps={["phone_missing"]} />
        ),
    },
    { id: "place", header: t("place"), accessor: (r) => place(r) || null, className: "min-w-32" },
    {
      id: "stage",
      header: t("stage"),
      cell: (r) => <Badge tone={lifecycleTone(r.lifecycle_stage)}>{tStage(r.lifecycle_stage)}</Badge>,
    },
    { id: "rep", header: t("rep"), accessor: (r) => rep(r) || null, className: "min-w-32" },
    {
      id: "balance",
      header: t("balance"),
      accessor: (r) => toNumber(r.balance),
      sortable: true,
      align: "end",
      cell: (r) => (
        <span className="inline-flex flex-col items-end gap-0.5">
          <span className="whitespace-nowrap tabular-nums">{balance(r) ?? "—"}</span>
          {overdueBadge(r)}
        </span>
      ),
    },
    {
      id: "location",
      header: t("location"),
      cell: (r) => {
        const loc = locationStatus(r);
        return <Badge tone={LOCATION_TONE[loc]}>{tLoc(loc)}</Badge>;
      },
    },
  ];

  const mobileCard = (r: CustomerListRow) => (
    <div className="space-y-1.5">
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
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {rep(r) ? <span>{t("repShort", { name: rep(r) })}</span> : null}
        {balance(r) !== null ? <span className="tabular-nums">{balance(r)}</span> : null}
        {overdueBadge(r)}
        <GapBadges gaps={customerGaps(r)} />
      </div>
    </div>
  );

  const filtered = active.length > 0;
  const empty = filtered ? (
    <EmptyState
      icon={<SlidersHorizontalIcon aria-hidden="true" />}
      title={t("emptyFilteredTitle")}
      description={t("emptyFilteredBody")}
      action={
        <Button type="button" variant="outline" onClick={() => go(null)}>
          {t("clear")}
        </Button>
      }
    />
  ) : (
    <EmptyState icon={<UsersIcon aria-hidden="true" />} title={t("emptyTitle")} description={t("emptyBody")} action={actions} />
  );

  return (
    <div className="space-y-3">
      <QuickFilters params={params} onChange={go} />
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        rowHref={(r) => `/customers/${r.id}`}
        server={{ rowCount: total, state: url.state, onStateChange: url.onStateChange }}
        loading={url.pending || filtering}
        searchPlaceholder={t("searchPlaceholder")}
        filters={
          <FilterPanel
            params={params}
            territories={territories}
            specialties={specialties}
            reps={reps}
            activeCount={active.filter((k) => k !== "overdue" && k !== "phone" && k !== "location").length}
            onChange={go}
          />
        }
        actions={actions}
        error={error}
        empty={empty}
        mobileCard={mobileCard}
        caption={t("title")}
      />
    </div>
  );
}

/** One-tap toggles for the gaps a rep fixes on the next visit, and overdue receivables. */
function QuickFilters({
  params,
  onChange,
}: {
  params: CustomerListParams;
  onChange: (change: Partial<Record<CustomerFilterKey, string | undefined>>) => void;
}) {
  const t = useTranslations("crm.list");
  const chips: { key: "overdue" | "phone" | "location"; value: string; label: string; icon: ReactNode }[] = [
    { key: "overdue", value: "1", label: t("overdue"), icon: <CircleAlertIcon aria-hidden="true" /> },
    { key: "phone", value: "missing", label: t("phoneMissing"), icon: <PhoneOffIcon aria-hidden="true" /> },
    { key: "location", value: "missing", label: t("locationMissing"), icon: <MapPinOffIcon aria-hidden="true" /> },
  ];
  return (
    <div role="group" aria-label={t("filters")} className="flex flex-wrap gap-2">
      {chips.map((chip) => {
        const on = Boolean(params[chip.key]);
        return (
          <button
            key={chip.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange({ [chip.key]: on ? undefined : chip.value })}
            className={cn(
              "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-4",
              on ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
            )}
          >
            {chip.icon}
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}

/** Stage, territory, specialty and rep: inline from `md`, in a bottom sheet on phones. */
function FilterPanel({
  params,
  territories,
  specialties,
  reps,
  activeCount,
  onChange,
}: {
  params: CustomerListParams & { sort?: string };
  territories: FilterOption[];
  specialties: FilterOption[];
  reps: FilterOption[];
  activeCount: number;
  onChange: (change: Partial<Record<CustomerFilterKey, string | undefined>> | null) => void;
}) {
  const t = useTranslations("crm.list");
  const controls = (compact: boolean) => (
    <FilterControls params={params} territories={territories} specialties={specialties} reps={reps} compact={compact} onChange={onChange} />
  );
  const anyFilter = activeCustomerFilters(params).length > 0;

  return (
    <>
      <div className="hidden flex-wrap items-end gap-2 md:flex">
        {controls(true)}
        {anyFilter ? (
          <Link href={customerListHref(params, null)} className={buttonVariants({ variant: "ghost" })}>
            {t("clear")}
          </Link>
        ) : null}
      </div>
      <Sheet>
        <SheetTrigger asChild>
          <Button type="button" variant="outline" className="w-full md:hidden">
            <SlidersHorizontalIcon aria-hidden="true" />
            {t("filters")}
            {activeCount > 0 ? <Badge variant="default">{activeCount}</Badge> : null}
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom" closeLabel={t("done")}>
          <SheetHeader>
            <SheetTitle>{t("filters")}</SheetTitle>
          </SheetHeader>
          <div className="grid gap-3 px-4">{controls(false)}</div>
          <SheetFooter>
            {anyFilter ? (
              <Link href={customerListHref(params, null)} className={buttonVariants({ variant: "outline" })}>
                {t("clear")}
              </Link>
            ) : null}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}

function FilterControls({
  params,
  territories,
  specialties,
  reps,
  compact,
  onChange,
}: {
  params: CustomerListParams;
  territories: FilterOption[];
  specialties: FilterOption[];
  reps: FilterOption[];
  compact: boolean;
  onChange: (change: Partial<Record<CustomerFilterKey, string | undefined>>) => void;
}) {
  const t = useTranslations("crm.list");
  const tStage = useTranslations("crm.stage");
  const uid = useId();
  const width = compact ? "w-44" : "w-full";
  const select = (key: CustomerFilterKey, label: string, all: string, options: FilterOption[]) => (
    <FormField id={`${uid}-${key}`} label={label} className={compact ? "space-y-1" : undefined}>
      <NativeSelect value={params[key] ?? ""} onChange={(e) => onChange({ [key]: e.target.value || undefined })} className={width}>
        <option value="">{all}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    </FormField>
  );

  return (
    <>
      {select("stage", t("stage"), t("allStages"), LIFECYCLE_STAGES.map((s) => ({ value: s, label: tStage(s) })))}
      {territories.length > 0 ? select("territory", t("territory"), t("allTerritories"), territories) : null}
      {specialties.length > 0 ? select("specialty", t("specialty"), t("allSpecialties"), specialties) : null}
      {reps.length > 1 ? (
        <FormField id={`${uid}-rep`} label={t("rep")} className={compact ? "space-y-1" : undefined}>
          <Combobox
            options={reps}
            value={params.rep ?? null}
            onValueChange={(value) => onChange({ rep: value ?? undefined })}
            placeholder={t("allReps")}
            searchPlaceholder={t("repSearch")}
            emptyText={t("repEmpty")}
            className={compact ? "w-52" : undefined}
          />
        </FormField>
      ) : null}
    </>
  );
}
