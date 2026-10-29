"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { callCommand } from "@/lib/command";
import { customerChanges, locationFixProblem, toActionFailure } from "./logic";
import { getCustomer } from "./queries";
import {
  createCustomerSchema,
  createOpportunitySchema,
  formToObject,
  invalidFieldsOf,
  logActivitySchema,
  moveOpportunitySchema,
  reassignSchema,
  setLocationSchema,
  updateCustomerSchema,
} from "./schemas";
import type {
  ActionFailure,
  ActionResult,
  ActionState,
  CreateCustomerResult,
  CreateCustomerState,
  CustomerFormState,
  DuplicateCheck,
  FormResultState,
} from "./types";

/**
 * CRM mutations. Each action validates FormData, calls api.* commands as the
 * signed-in user (callCommand) and refreshes the pages that show the result.
 * Authorization is NOT decided here: hidden inputs are untrusted and the
 * database re-checks every permission, scope and state rule.
 */

const PAGES = {
  customers: "/[locale]/customers",
  customer: "/[locale]/customers/[id]",
  opportunities: "/[locale]/opportunities",
} as const;

function refresh(...pages: (keyof typeof PAGES)[]) {
  for (const page of new Set(pages)) revalidatePath(PAGES[page], "page");
}

const invalid = (fields: string[], values?: Record<string, string>): ActionFailure & { values?: Record<string, string> } => ({
  ok: false,
  messageKey: fields.includes("reason") || fields.includes("lost_reason") ? "REASON_REQUIRED" : "VALIDATION",
  invalidFields: fields,
  ...(values ? { values } : {}),
});

async function command(name: string, args: Record<string, unknown>, ...pages: (keyof typeof PAGES)[]): Promise<ActionResult> {
  const result = await callCommand(name, args);
  if (!result.ok) return toActionFailure(result.error);
  refresh(...pages);
  return { ok: true };
}

/** Attach the typed values to a failure so the form can refill them. */
const withValues = (raw: Record<string, string>, result: ActionResult): FormResultState =>
  result.ok ? result : { ...result, values: echo(raw) };

const localeOf = (form: FormData): "ar" | "en" => (form.get("locale") === "en" ? "en" : "ar");

/** Form values to send back for refilling (never anything read from the database). */
function echo(raw: Record<string, string>): Record<string, string> {
  const values = { ...raw };
  delete values.client_ref;
  delete values.confirm_duplicates;
  return values;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/**
 * Create a customer. Unless the user already confirmed, the possible-duplicate
 * pre-check runs first so they can cancel BEFORE a record exists. The command
 * itself re-checks hard duplicates (same phone) and is idempotent on client_ref.
 */
export async function createCustomer(_prev: CreateCustomerState, form: FormData): Promise<CreateCustomerState> {
  const raw = formToObject(form);
  const parsed = createCustomerSchema.safeParse(raw);
  if (!parsed.success) return { ...invalid(invalidFieldsOf(parsed.error)), values: echo(raw) };
  const input = parsed.data;

  if (!input.confirm_duplicates) {
    const check = await callCommand<DuplicateCheck>("find_duplicate_customers", {
      p_doctor_name: input.doctor_name ?? null,
      p_clinic_name: input.clinic_name ?? null,
      p_phone_primary: input.phone_primary,
      p_governorate_code: input.governorate_code,
      p_display_name: input.display_name ?? null,
    });
    if (!check.ok) return { ...toActionFailure(check.error), values: echo(raw) };
    if (check.data.phone_duplicate_customer_no) {
      return {
        ok: false,
        messageKey: "DUPLICATE",
        crmCode: "DUPLICATE_CUSTOMER",
        params: { customerNo: check.data.phone_duplicate_customer_no },
        invalidFields: ["phone_primary"],
        values: echo(raw),
      };
    }
    if (check.data.similar_count > 0) {
      return { ok: "confirm", similar: check.data.similar_customer_nos, similarCount: check.data.similar_count, values: echo(raw) };
    }
  }

  const created = await callCommand<CreateCustomerResult>("create_customer", {
    p_doctor_name: input.doctor_name ?? null,
    p_clinic_name: input.clinic_name ?? null,
    p_display_name: input.display_name ?? null,
    p_phone_primary: input.phone_primary,
    p_phone_secondary: input.phone_secondary ?? null,
    p_email: input.email ?? null,
    p_kind: input.kind,
    p_specialty_code: input.specialty_code ?? null,
    p_governorate_code: input.governorate_code,
    p_city: input.city ?? null,
    p_address_line: input.address_line ?? null,
    p_source: input.source,
    p_tags: input.tags,
    p_notes: input.notes ?? null,
    p_client_ref: input.client_ref,
  });
  if (!created.ok) return { ...toActionFailure(created.error), values: echo(raw) };

  refresh("customers");
  redirect(`/${input.locale}/customers/${created.data.customer_id}?created=1`);
}

export async function updateCustomer(_prev: CustomerFormState, form: FormData): Promise<CustomerFormState> {
  const raw = formToObject(form);
  const parsed = updateCustomerSchema.safeParse(raw);
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error), echo(raw));
  const input = parsed.data;

  // The diff is computed against the current row; the version from the form
  // still guards against overwriting someone else's edit (CONFLICT).
  const current = await getCustomer(input.customer_id);
  if (!current.ok) return { ...toActionFailure(current.error), values: echo(raw) };
  if (!current.data) return { ok: false, messageKey: "NOT_FOUND", values: echo(raw) };

  const changes = customerChanges(current.data, input);
  if (Object.keys(changes).length > 0) {
    const result = await callCommand("update_customer", {
      p_customer_id: input.customer_id,
      p_version: input.version,
      p_changes: changes,
    });
    if (!result.ok) return { ...toActionFailure(result.error), values: echo(raw) };
    refresh("customers", "customer", "opportunities");
  }
  redirect(`/${input.locale}/customers/${input.customer_id}?saved=1`);
}

export async function logActivity(_prev: FormResultState, form: FormData): Promise<FormResultState> {
  const raw = formToObject(form);
  const parsed = logActivitySchema.safeParse(raw);
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error), raw);
  const { customer_id, type, summary, occurred_at } = parsed.data;
  return withValues(raw, await command(
    "log_activity",
    { p_customer_id: customer_id, p_type: type, p_summary: summary, ...(occurred_at ? { p_occurred_at: occurred_at } : {}) },
    "customer",
  ));
}

/** Starts the crm.customer.reassign approval workflow; nothing changes until it is approved. */
export async function requestReassignment(_prev: FormResultState, form: FormData): Promise<FormResultState> {
  const raw = formToObject(form);
  const parsed = reassignSchema.safeParse(raw);
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error), raw);
  const { customer_id, to_employee_id, reason } = parsed.data;
  return withValues(
    raw,
    await command(
      "request_customer_reassignment",
      { p_customer_id: customer_id, p_to_employee_id: to_employee_id, p_reason: reason },
      "customer",
    ),
  );
}

export async function setCustomerLocation(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = setLocationSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error));
  const { customer_id, latitude, longitude, accuracy_m } = parsed.data;
  // The command has no accuracy parameter, so a poor fix is refused here as well as in the browser.
  if (locationFixProblem({ lat: latitude, lng: longitude, accuracy: accuracy_m }) === "LOCATION_INACCURATE") {
    return { ok: false, messageKey: "VALIDATION", crmCode: "LOCATION_INACCURATE" };
  }
  return command("set_customer_location", { p_customer_id: customer_id, p_lat: latitude, p_lng: longitude }, "customer", "customers");
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export async function createOpportunity(_prev: CustomerFormState, form: FormData): Promise<CustomerFormState> {
  const raw = formToObject(form);
  const parsed = createOpportunitySchema.safeParse(raw);
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error), echo(raw));
  const input = parsed.data;
  const result = await callCommand("create_opportunity", {
    p_customer_id: input.customer_id,
    p_title: input.title,
    p_expected_value: input.expected_value ?? null,
    p_expected_close_date: input.expected_close_date ?? null,
  });
  if (!result.ok) return { ...toActionFailure(result.error), values: echo(raw) };
  refresh("opportunities", "customer");
  redirect(`/${localeOf(form)}/opportunities?created=1`);
}

export async function moveOpportunity(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = moveOpportunitySchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(invalidFieldsOf(parsed.error));
  const { opportunity_id, stage, lost_reason } = parsed.data;
  return command(
    "move_opportunity",
    { p_opportunity_id: opportunity_id, p_stage: stage, p_lost_reason: stage === "lost" ? lost_reason : null },
    "opportunities",
    "customer",
  );
}
