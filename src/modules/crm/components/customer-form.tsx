"use client";

import { useTranslations } from "next-intl";
import { useActionState, type ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { createCustomer, updateCustomer } from "../actions";
import { CUSTOMER_KINDS, CUSTOMER_SOURCES, type CreateCustomerState, type CustomerFormState } from "../types";
import { CrmErrorMessage } from "./crm-error";
import { Textarea } from "./textarea";

export interface Option {
  value: string;
  label: string;
}

interface Shared {
  locale: "ar" | "en";
  governorates: Option[];
  specialties: Option[];
  /** Current values (edit) or defaults (create). */
  initial: Record<string, string>;
  cancelHref: string;
}

/**
 * New customer. A possible duplicate (similar name in the same governorate)
 * stops the submit and asks the user to confirm or cancel before anything is
 * created; the same phone on an active customer is refused outright.
 * `clientRef` is fixed for the life of the form so a repeated submit replays.
 */
export function CreateCustomerForm({ clientRef, ...shared }: Shared & { clientRef: string }) {
  const t = useTranslations("crm.form");
  const [state, formAction, pending] = useActionState<CreateCustomerState, FormData>(createCustomer, null);
  const confirming = state?.ok === "confirm";
  const values = { ...shared.initial, ...(state?.values ?? {}) };
  const invalid = new Set(state && state.ok === false ? (state.invalidFields ?? []) : []);

  return (
    <form key={JSON.stringify(state)} action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="client_ref" value={clientRef} />
      <input type="hidden" name="locale" value={shared.locale} />
      {confirming ? <input type="hidden" name="confirm_duplicates" value="1" /> : null}

      {state && state.ok === false ? <CrmErrorMessage failure={state} /> : null}
      {confirming ? (
        <Alert tone="info" className="space-y-1">
          <p className="font-medium">{t("duplicateTitle", { count: state.similarCount })}</p>
          <p>{t("duplicateBody")}</p>
          <p dir="ltr" className="text-start font-mono text-xs">
            {state.similar.join(" · ")}
          </p>
        </Alert>
      ) : null}

      <CustomerFields values={values} invalid={invalid} {...shared} showSource />

      <FormFooter cancelHref={shared.cancelHref}>
        <Button type="submit" disabled={pending} className="flex-1 sm:flex-none">
          {confirming ? t("createAnyway") : t("create")}
        </Button>
      </FormFooter>
    </form>
  );
}

/** Edit an existing customer: only the changed fields are sent, guarded by `version`. */
export function EditCustomerForm({
  customerId,
  version,
  stageOptions,
  ...shared
}: Shared & { customerId: string; version: number; stageOptions: Option[] }) {
  const t = useTranslations("crm.form");
  const [state, formAction, pending] = useActionState<CustomerFormState, FormData>(updateCustomer, null);
  const values = { ...shared.initial, ...(state?.values ?? {}) };
  const invalid = new Set(state?.invalidFields ?? []);

  return (
    <form key={JSON.stringify(state)} action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="customer_id" value={customerId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="locale" value={shared.locale} />

      {state ? <CrmErrorMessage failure={state} /> : null}

      <div className="space-y-2">
        <Label htmlFor="cust-lifecycle_stage">{t("lifecycleStage")}</Label>
        <Select id="cust-lifecycle_stage" name="lifecycle_stage" defaultValue={values.lifecycle_stage} className="w-full sm:w-64">
          {stageOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>

      <CustomerFields values={values} invalid={invalid} {...shared} />

      <FormFooter cancelHref={shared.cancelHref}>
        <Button type="submit" disabled={pending} className="flex-1 sm:flex-none">
          {t("save")}
        </Button>
      </FormFooter>
    </form>
  );
}

/** Primary action pinned to the bottom of the screen on mobile. */
function FormFooter({ cancelHref, children }: { cancelHref: string; children: ReactNode }) {
  const t = useTranslations("crm.form");
  return (
    <div className="sticky bottom-0 z-[1] -mx-4 flex gap-2 border-t bg-card/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0">
      {children}
      <Link href={cancelHref} className={buttonVariants({ variant: "outline" })}>
        {t("cancel")}
      </Link>
    </div>
  );
}

function CustomerFields({
  values,
  invalid,
  governorates,
  specialties,
  showSource = false,
}: Shared & { values: Record<string, string>; invalid: Set<string>; showSource?: boolean }) {
  const t = useTranslations("crm.form");
  const tKind = useTranslations("crm.kind");
  const tSource = useTranslations("crm.source");

  const field = (name: string) => ({
    id: `cust-${name}`,
    name,
    defaultValue: values[name] ?? "",
    "aria-invalid": invalid.has(name) || undefined,
  });
  const optional = <span className="text-muted-foreground">({t("optional")})</span>;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <p className="text-sm text-muted-foreground sm:col-span-2">{t("nameHint")}</p>
      <div className="space-y-2">
        <Label htmlFor="cust-clinic_name">{t("clinicName")}</Label>
        <Input {...field("clinic_name")} maxLength={160} autoComplete="off" placeholder={t("clinicPlaceholder")} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="cust-doctor_name">{t("doctorName")}</Label>
        <Input {...field("doctor_name")} maxLength={160} autoComplete="off" placeholder={t("doctorPlaceholder")} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="cust-phone_primary">{t("phonePrimary")}</Label>
        <Input
          {...field("phone_primary")}
          type="tel"
          inputMode="tel"
          dir="ltr"
          required
          autoComplete="off"
          placeholder="01X XXXX XXXX"
          aria-describedby="cust-phone-hint"
        />
        <p id="cust-phone-hint" className="text-xs text-muted-foreground">
          {t("phoneHint")}
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="cust-phone_secondary">
          {t("phoneSecondary")} {optional}
        </Label>
        <Input {...field("phone_secondary")} type="tel" inputMode="tel" dir="ltr" autoComplete="off" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="cust-governorate_code">{t("governorate")}</Label>
        <Select {...field("governorate_code")} required className="w-full">
          <option value="">{t("choose")}</option>
          {governorates.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="cust-city">
          {t("city")} {optional}
        </Label>
        <Input {...field("city")} maxLength={120} autoComplete="off" />
      </div>

      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="cust-address_line">
          {t("address")} {optional}
        </Label>
        <Input {...field("address_line")} maxLength={300} autoComplete="off" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="cust-kind">{t("kind")}</Label>
        <Select {...field("kind")} defaultValue={values.kind || "clinic"} className="w-full">
          {CUSTOMER_KINDS.map((k) => (
            <option key={k} value={k}>
              {tKind(k)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="cust-specialty_code">
          {t("specialty")} {optional}
        </Label>
        <Select {...field("specialty_code")} className="w-full">
          <option value="">{t("none")}</option>
          {specialties.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="cust-email">
          {t("email")} {optional}
        </Label>
        <Input {...field("email")} type="email" inputMode="email" dir="ltr" maxLength={254} autoComplete="off" />
      </div>
      {showSource ? (
        <div className="space-y-2">
          <Label htmlFor="cust-source">{t("source")}</Label>
          <Select {...field("source")} defaultValue={values.source || "field"} className="w-full">
            {CUSTOMER_SOURCES.map((s) => (
              <option key={s} value={s}>
                {tSource(s)}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="cust-display_name">
            {t("displayName")} {optional}
          </Label>
          <Input {...field("display_name")} maxLength={200} autoComplete="off" />
        </div>
      )}

      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="cust-tags">
          {t("tags")} {optional}
        </Label>
        <Input {...field("tags")} maxLength={500} autoComplete="off" aria-describedby="cust-tags-hint" />
        <p id="cust-tags-hint" className="text-xs text-muted-foreground">
          {t("tagsHint")}
        </p>
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="cust-notes">
          {t("notes")} {optional}
        </Label>
        <Textarea {...field("notes")} maxLength={2000} />
      </div>
    </div>
  );
}
