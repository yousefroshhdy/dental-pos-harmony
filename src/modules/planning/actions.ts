"use server";

import { revalidatePath } from "next/cache";
import { callCommand } from "@/lib/command";
import type { AppError } from "@/lib/errors";
import { addVisitSchema, formToObject, savePlanSchema, setFrequencySchema, unplanSchema, visitsFromForm } from "./schemas";
import type { ActionResult, ActionState, PlanResult } from "./types";

/**
 * Planning mutations. Each action validates its input, calls exactly one api.* command as the
 * signed-in user (callCommand) and refreshes the pages that show the result. Authorization is NOT
 * decided here: employee and customer ids are untrusted, and the database re-checks permission,
 * team scope, assignment, past days and duplicates. Plans carry a client_ref generated on the
 * device, so a double tap or a resend after a lost response plans once.
 */

const PAGES = {
  planning: "/[locale]/planning",
  generate: "/[locale]/planning/generate",
  coverage: "/[locale]/planning/coverage",
  today: "/[locale]/today",
} as const;

function refresh(...pages: (keyof typeof PAGES)[]) {
  for (const page of new Set(pages)) revalidatePath(PAGES[page], "page");
}

const failed = (error: AppError): ActionResult => ({
  ok: false,
  code: error.code,
  messageKey: error.messageKey,
  requestId: error.requestId,
});
const invalid = (): ActionResult => ({ ok: false, code: "VALIDATION", messageKey: "VALIDATION" });

/** One visit from the week grid. */
export async function addPlannedVisit(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = addVisitSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid();
  const { employee_id, customer_id, date, client_ref } = parsed.data;
  const result = await callCommand<PlanResult>("plan_visits", {
    p_employee_id: employee_id ?? null,
    p_visits: [{ customer_id, date }],
    p_client_ref: client_ref,
  });
  if (!result.ok) return failed(result.error);
  refresh("planning", "coverage", "today");
  return { ok: true, created: result.data.created, from: result.data.from };
}

/** The reviewed month proposal: the checked rows only. */
export async function saveGeneratedPlan(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const fields = formToObject(form);
  const parsed = savePlanSchema.safeParse({
    employee_id: fields.employee_id,
    client_ref: fields.client_ref,
    visits: visitsFromForm(form),
  });
  if (!parsed.success) return invalid();
  const result = await callCommand<PlanResult>("plan_visits", {
    p_employee_id: parsed.data.employee_id,
    p_visits: parsed.data.visits,
    p_client_ref: parsed.data.client_ref,
  });
  if (!result.ok) return failed(result.error);
  refresh("planning", "generate", "coverage", "today");
  return { ok: true, created: result.data.created, from: result.data.from };
}

export async function unplanVisit(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = unplanSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid();
  const result = await callCommand("unplan_visit", { p_visit_id: parsed.data.visit_id });
  if (!result.ok) return failed(result.error);
  refresh("planning", "coverage", "today");
  return { ok: true };
}

export async function setVisitFrequency(_prev: ActionState, form: FormData): Promise<ActionResult> {
  const parsed = setFrequencySchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid();
  const result = await callCommand("set_visit_frequency", {
    p_customer_id: parsed.data.customer_id,
    p_visit_class: parsed.data.visit_class,
  });
  if (!result.ok) return failed(result.error);
  refresh("coverage", "planning", "generate");
  return { ok: true };
}
