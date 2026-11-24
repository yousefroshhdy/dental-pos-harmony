"use client";

import { PhoneOffIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useState, type ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
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
 * The phone is optional (Phase P): without one, the customer is created and
 * marked "phone missing" for the rep to complete on the next visit.
 * `clientRef` is fixed for the life of the form so a repeated submit replays.
 */
export function CreateCustomerForm({ clientRef, ...shared }: Shared & { clientRef: string }) {
  const t = useTranslations("crm.form");
  const [state, formAction, pending] = useActionState<CreateCustomerState, FormData>(createCustomer, null);
  const confirming = state?.ok === "confirm";
  const values = { ...shared.initial, ...(state?.values ?? {}) };
  const invalid = new Set(state && state.ok === false ? (state.invalidFields ?? []) : []);

  return (
    <form key={JSON.stringify(state)} action={formAction} className="space-y-6" noValidate>
      <input type="hidden" name="client_ref" value={clientRef} />
      <input type="hidden" name="locale" value={shared.locale} />
      {confirming ? <input type="hidden" name="confirm_duplicates" value="1" /> : null}

      {state && state.ok === false ? <CrmErrorMessage failure={state} /> : null}
      {confirming ? (
        <Alert tone="info" className="space-y-1">
          {state.similarCount > 0 ? (
            <>
              <p className="font-medium">{t("duplicateTitle", { count: state.similarCount })}</p>
              <p>{t("duplicateBody")}</p>
              <p dir="ltr" className="text-start font-mono text-xs">
                {state.similar.join(" · ")}
              </p>
            </>
          ) : null}
          {/* A match the user cannot see: no number, no count (audit Phase 3 F7). */}
          {state.outsideScope ? <p className={state.similarCount > 0 ? undefined : "font-medium"}>{t("duplicateOutsideScope")}</p> : null}
        </Alert>
      ) : null}

      <CustomerFields values={values} invalid={invalid} {...shared} showSource phoneRequired={false} />

      <FormFooter cancelHref={shared.cancelHref}>
        <Button type="submit" disabled={pending} className="flex-1 sm:flex-none">
          {confirming ? t("createAnyway") : t("create")}
        </Button>
      </FormFooter>
    </form>
  );
}

/**
 * Edit an existing customer: only the changed fields are sent, guarded by `version`. A saved
 * phone can be corrected but not removed, so the field is required once the customer has one.
 */
export function EditCustomerForm({
  customerId,
  version,
  stageOptions,
  hasPhone,
  ...shared
}: Shared & { customerId: string; version: number; stageOptions: Option[]; hasPhone: boolean }) {
  const t = useTranslations("crm.form");
  const [state, formAction, pending] = useActionState<CustomerFormState, FormData>(updateCustomer, null);
  const values = { ...shared.initial, ...(state?.values ?? {}) };
  const invalid = new Set(state?.invalidFields ?? []);

  return (
    <form key={JSON.stringify(state)} action={formAction} className="space-y-6" noValidate>
      <input type="hidden" name="customer_id" value={customerId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="locale" value={shared.locale} />

      {state ? <CrmErrorMessage failure={state} /> : null}

      <FormField id="cust-lifecycle_stage" label={t("lifecycleStage")}>
        <NativeSelect name="lifecycle_stage" defaultValue={values.lifecycle_stage} className="w-full sm:w-64">
          {stageOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </FormField>

      <CustomerFields values={values} invalid={invalid} {...shared} phoneRequired={hasPhone} />

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-4 rounded-lg border bg-card p-4 sm:p-5">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

/** Message for a field the server marked invalid (shared `form.*` wording, Arabic first). */
function useFieldError(invalid: Set<string>) {
  const t = useTranslations("crm.form");
  const tForm = useTranslations("form");
  const tErrors = useTranslations("crm.errors");
  return (name: string, crmCode?: string): string | undefined => {
    if (!invalid.has(name)) return undefined;
    if (crmCode === "PHONE_REQUIRED" && name === "phone_primary") return tErrors("PHONE_REQUIRED");
    if (name === "phone_primary" || name === "phone_secondary") return tForm("phone");
    if (name === "email") return tForm("email");
    if (name === "governorate_code") return tForm("required");
    if (name === "clinic_name" || name === "doctor_name") return t("nameHint");
    return tForm("invalid");
  };
}

function CustomerFields({
  values,
  invalid,
  governorates,
  specialties,
  showSource = false,
  phoneRequired,
}: Shared & { values: Record<string, string>; invalid: Set<string>; showSource?: boolean; phoneRequired: boolean }) {
  const t = useTranslations("crm.form");
  const tKind = useTranslations("crm.kind");
  const tSource = useTranslations("crm.source");
  const errorFor = useFieldError(invalid);
  const [phone, setPhone] = useState(values.phone_primary ?? "");

  const field = (name: string) => ({ name, defaultValue: values[name] ?? "" });
  const id = (name: string) => `cust-${name}`;
  const optional = `(${t("optional")})`;
  const noPhone = !phoneRequired && phone.trim() === "";

  return (
    <div className="space-y-5">
      <Section title={t("sectionIdentity")}>
        <p className="text-sm text-muted-foreground sm:col-span-2">{t("nameHint")}</p>
        <FormField id={id("clinic_name")} label={t("clinicName")} error={errorFor("clinic_name")}>
          <Input {...field("clinic_name")} maxLength={160} autoComplete="off" placeholder={t("clinicPlaceholder")} />
        </FormField>
        <FormField id={id("doctor_name")} label={t("doctorName")} error={invalid.has("clinic_name") ? undefined : errorFor("doctor_name")}>
          <Input {...field("doctor_name")} maxLength={160} autoComplete="off" placeholder={t("doctorPlaceholder")} />
        </FormField>
        <FormField id={id("kind")} label={t("kind")} error={errorFor("kind")}>
          <NativeSelect name="kind" defaultValue={values.kind || "clinic"} className="w-full">
            {CUSTOMER_KINDS.map((k) => (
              <option key={k} value={k}>
                {tKind(k)}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField id={id("specialty_code")} label={t("specialty")} optionalText={optional} error={errorFor("specialty_code")}>
          <NativeSelect {...field("specialty_code")} className="w-full">
            <option value="">{t("none")}</option>
            {specialties.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </Section>

      <Section title={t("sectionContact")}>
        <FormField
          id={id("phone_primary")}
          label={t("phonePrimary")}
          required={phoneRequired}
          optionalText={phoneRequired ? undefined : optional}
          hint={phoneRequired ? t("phoneHint") : `${t("phoneHint")} ${t("phoneOptionalHint")}`}
          error={errorFor("phone_primary", invalid.has("phone_primary") && phoneRequired && phone.trim() === "" ? "PHONE_REQUIRED" : undefined)}
        >
          <Input
            name="phone_primary"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            type="tel"
            inputMode="tel"
            dir="ltr"
            required={phoneRequired}
            autoComplete="off"
            placeholder="01X XXXX XXXX"
          />
        </FormField>
        <FormField id={id("phone_secondary")} label={t("phoneSecondary")} optionalText={optional} error={errorFor("phone_secondary")}>
          <Input {...field("phone_secondary")} type="tel" inputMode="tel" dir="ltr" autoComplete="off" />
        </FormField>
        {noPhone ? (
          <Alert tone="warning" role="status" className="flex items-start gap-2 sm:col-span-2">
            <PhoneOffIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{t("phoneMissingWarning")}</span>
          </Alert>
        ) : null}
        <FormField id={id("email")} label={t("email")} optionalText={optional} error={errorFor("email")} className="sm:col-span-2">
          <Input {...field("email")} type="email" inputMode="email" dir="ltr" maxLength={254} autoComplete="off" />
        </FormField>
      </Section>

      <Section title={t("sectionPlace")}>
        <FormField id={id("governorate_code")} label={t("governorate")} required error={errorFor("governorate_code")}>
          <NativeSelect {...field("governorate_code")} required className="w-full">
            <option value="">{t("choose")}</option>
            {governorates.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField id={id("city")} label={t("city")} optionalText={optional} error={errorFor("city")}>
          <Input {...field("city")} maxLength={120} autoComplete="off" />
        </FormField>
        <FormField id={id("address_line")} label={t("address")} optionalText={optional} error={errorFor("address_line")} className="sm:col-span-2">
          <Input {...field("address_line")} maxLength={300} autoComplete="off" />
        </FormField>
      </Section>

      <Section title={t("sectionMore")}>
        {showSource ? (
          <FormField id={id("source")} label={t("source")} error={errorFor("source")}>
            <NativeSelect name="source" defaultValue={values.source || "field"} className="w-full">
              {CUSTOMER_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {tSource(s)}
                </option>
              ))}
            </NativeSelect>
          </FormField>
        ) : (
          <FormField id={id("display_name")} label={t("displayName")} optionalText={optional} error={errorFor("display_name")}>
            <Input {...field("display_name")} maxLength={200} autoComplete="off" />
          </FormField>
        )}
        <FormField id={id("tags")} label={t("tags")} optionalText={optional} hint={t("tagsHint")} error={errorFor("tags")}>
          <Input {...field("tags")} maxLength={500} autoComplete="off" />
        </FormField>
        <FormField id={id("notes")} label={t("notes")} optionalText={optional} error={errorFor("notes")} className="sm:col-span-2">
          <Textarea {...field("notes")} maxLength={2000} />
        </FormField>
      </Section>
    </div>
  );
}
