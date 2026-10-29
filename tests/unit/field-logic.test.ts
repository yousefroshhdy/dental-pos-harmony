import { describe, expect, it } from "vitest";
import { ANONYMOUS_CONTEXT, type Scope, type UserContext } from "@/lib/authz/can";
import {
  cairoDate,
  cairoDayBounds,
  canCheckOut,
  canCompleteTask,
  canRequestException,
  canSeeOthersTasks,
  canSeeToday,
  fieldErrorCode,
  groupToday,
  needsException,
  parseTaskFilters,
  sanitizeSearch,
  taskFilterHref,
  taskTone,
  toCairoLocalInput,
  toMetres,
  verificationTone,
  zonedLocalToInstant,
} from "@/modules/field/logic";
import { VERIFICATION_STATUSES, type TodayItem } from "@/modules/field/types";

const ME = "11111111-1111-4111-8111-111111111111";
const EMP = "33333333-3333-4333-8333-333333333333";
const OTHER_EMP = "44444444-4444-4444-8444-444444444444";

function ctx(permissions: Record<string, Scope>, extra: Partial<UserContext> = {}): UserContext {
  return {
    ...ANONYMOUS_CONTEXT,
    user_id: ME,
    active: true,
    status: "active",
    employee: { id: EMP, employee_no: "E-TEST-1", full_name_en: "Test Rep", full_name_ar: null, job_title: "Rep" },
    permissions: Object.fromEntries(Object.entries(permissions).map(([k, scope]) => [k, { scope, limit: null }])),
    ...extra,
  };
}

describe("Cairo time helpers", () => {
  it("converts a winter wall-clock time (UTC+2)", () => {
    expect(zonedLocalToInstant("2026-01-15T10:00")?.toISOString()).toBe("2026-01-15T08:00:00.000Z");
  });

  it("converts a summer wall-clock time (UTC+3, Egyptian DST)", () => {
    expect(zonedLocalToInstant("2026-07-15T10:00")?.toISOString()).toBe("2026-07-15T07:00:00.000Z");
  });

  it("treats a bare date as Cairo midnight", () => {
    expect(zonedLocalToInstant("2026-01-15")?.toISOString()).toBe("2026-01-14T22:00:00.000Z");
  });

  it("rejects malformed and impossible dates", () => {
    for (const bad of ["", "15/01/2026", "2026-02-31T10:00", "2026-13-01T10:00", "2026-01-01T24:00", "2026-01-01T10:60"]) {
      expect(zonedLocalToInstant(bad)).toBeNull();
    }
  });

  it("round-trips through the datetime-local value", () => {
    const instant = new Date("2026-03-03T13:45:00Z");
    expect(toCairoLocalInput(instant)).toBe("2026-03-03T15:45");
    expect(zonedLocalToInstant(toCairoLocalInput(instant))?.toISOString()).toBe(instant.toISOString());
  });

  it("uses the Cairo calendar day, not UTC", () => {
    // 23:30 UTC on 14 Jan is already 15 Jan in Cairo.
    expect(cairoDate(new Date("2026-01-14T23:30:00Z"))).toBe("2026-01-15");
    const { start, end } = cairoDayBounds(new Date("2026-01-14T23:30:00Z"));
    expect(start.toISOString()).toBe("2026-01-14T22:00:00.000Z");
    expect(end.toISOString()).toBe("2026-01-15T22:00:00.000Z");
  });

  it("gives a 24 h day in summer too", () => {
    const { start, end } = cairoDayBounds(new Date("2026-07-15T12:00:00Z"));
    expect(start.toISOString()).toBe("2026-07-14T21:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(24 * 3600 * 1000);
  });
});

describe("visit rules", () => {
  it("has a tone for every verdict and asks for an exception only when not verified", () => {
    for (const s of VERIFICATION_STATUSES) expect(verificationTone(s)).toBeTypeOf("string");
    expect(verificationTone("verified")).toBe("success");
    expect(verificationTone("out_of_range")).toBe("danger");
    expect(needsException("out_of_range")).toBe(true);
    expect(needsException("low_accuracy")).toBe(true);
    expect(needsException("no_device_location")).toBe(true);
    expect(needsException("no_customer_location")).toBe(true);
    expect(needsException("verified")).toBe(false);
    expect(needsException("exception_requested")).toBe(false);
    expect(needsException("exception_rejected")).toBe(false);
  });

  const visit = { employee_id: EMP, status: "in_progress" as const, verification_status: "out_of_range" as const };

  it("offers an exception for the rep's own visit with the permission", () => {
    const rep = ctx({ "field.visit_exception.request": "own" });
    expect(canRequestException(rep, visit)).toBe(true);
    expect(canRequestException(rep, { ...visit, employee_id: OTHER_EMP })).toBe(false);
    expect(canRequestException(rep, { ...visit, verification_status: "verified" })).toBe(false);
    expect(canRequestException(rep, { ...visit, status: "planned" })).toBe(false);
    expect(canRequestException(ctx({}), visit)).toBe(false);
    expect(canRequestException(ctx({ "field.visit_exception.request": "team" }), { ...visit, employee_id: OTHER_EMP })).toBe(true);
  });

  it("lets only the visiting rep check out an in-progress visit", () => {
    const rep = ctx({ "field.visit.create": "own" });
    expect(canCheckOut(rep, visit)).toBe(true);
    expect(canCheckOut(rep, { ...visit, status: "completed" })).toBe(false);
    expect(canCheckOut(rep, { ...visit, employee_id: OTHER_EMP })).toBe(false);
    expect(canCheckOut(ctx({ "field.visit.create": "own" }, { employee: null }), visit)).toBe(false);
    expect(canCheckOut(ctx({}), visit)).toBe(false);
  });

  it("rounds numeric distances", () => {
    expect(toMetres("123.6")).toBe(124);
    expect(toMetres(10)).toBe(10);
    expect(toMetres(null)).toBeNull();
    expect(toMetres("")).toBeNull();
    expect(toMetres("x")).toBeNull();
  });
});

describe("today", () => {
  const item = (over: Partial<TodayItem>): TodayItem => ({
    item_type: "task",
    item_id: crypto.randomUUID(),
    title: "Synthetic task",
    kind: "general",
    priority: "normal",
    status: "open",
    customer_id: null,
    customer_name: null,
    due_at: "2026-10-29T10:00:00Z",
    planned_for: null,
    is_overdue: false,
    ...over,
  });

  it("splits visits and tasks, follow-ups apart, overdue and urgent first", () => {
    const groups = groupToday([
      item({ title: "later", due_at: "2026-10-29T12:00:00Z" }),
      item({ title: "overdue", is_overdue: true, due_at: "2026-10-28T12:00:00Z" }),
      item({ title: "urgent", priority: "urgent", due_at: "2026-10-29T13:00:00Z" }),
      item({ title: "fu", kind: "follow_up" }),
      item({ item_type: "visit", kind: null, priority: null, status: "planned", title: "Clinic B", customer_name: "Clinic B" }),
      item({ item_type: "visit", kind: null, priority: null, status: "planned", title: "Clinic A", customer_name: "Clinic A" }),
      item({ item_type: "visit", kind: null, priority: null, status: "in_progress", title: "Clinic C" }),
    ]);
    expect(groups.tasks.map((t) => t.title)).toEqual(["overdue", "urgent", "later"]);
    expect(groups.followUps.map((t) => t.title)).toEqual(["fu"]);
    expect(groups.planned.map((t) => t.title)).toEqual(["Clinic A", "Clinic B"]);
    expect(groups.inProgress.map((t) => t.title)).toEqual(["Clinic C"]);
  });

  it("opens for check-in or task users only", () => {
    expect(canSeeToday(ctx({ "field.visit.create": "own" }))).toBe(true);
    expect(canSeeToday(ctx({ "work.task.read": "own" }))).toBe(true);
    expect(canSeeToday(ctx({ "crm.customer.read": "own" }))).toBe(false);
    expect(canSeeToday(ANONYMOUS_CONTEXT)).toBe(false);
  });
});

describe("tasks", () => {
  it("parses filters with safe defaults", () => {
    expect(parseTaskFilters({})).toEqual({ who: "mine", due: "any", status: "open" });
    expect(parseTaskFilters({ who: "all", due: "today", status: "done" })).toEqual({ who: "all", due: "today", status: "done" });
    expect(parseTaskFilters({ who: "everyone", due: "yesterday", status: "x" })).toEqual({ who: "mine", due: "any", status: "open" });
    expect(parseTaskFilters({ due: "overdue", status: "done" })).toEqual({ who: "mine", due: "any", status: "done" });
    expect(parseTaskFilters({ due: ["overdue", "today"] }).due).toBe("overdue");
  });

  it("builds filter links without defaults", () => {
    const f = parseTaskFilters({});
    expect(taskFilterHref(f, {})).toBe("/tasks");
    expect(taskFilterHref(f, { due: "overdue" })).toBe("/tasks?due=overdue");
    expect(taskFilterHref(f, { who: "all", status: "done" })).toBe("/tasks?who=all&status=done");
  });

  it("gates seeing others' tasks and completing them", () => {
    const rep = ctx({ "work.task.read": "own", "work.task.manage": "own" });
    const manager = ctx({ "work.task.read": "team", "work.task.manage": "team" });
    expect(canSeeOthersTasks(rep)).toBe(false);
    expect(canSeeOthersTasks(manager)).toBe(true);
    const mine = { status: "open" as const, assignee_employee_id: EMP };
    const theirs = { status: "open" as const, assignee_employee_id: OTHER_EMP };
    expect(canCompleteTask(rep, mine)).toBe(true);
    expect(canCompleteTask(rep, theirs)).toBe(false);
    expect(canCompleteTask(manager, theirs)).toBe(true);
    expect(canCompleteTask(rep, { ...mine, status: "done" })).toBe(false);
    expect(canCompleteTask(ctx({ "work.task.read": "own" }), mine)).toBe(false);
  });

  it("colours overdue and done tasks", () => {
    expect(taskTone({ status: "open", is_overdue: true })).toBe("danger");
    expect(taskTone({ status: "open", is_overdue: false })).toBe("info");
    expect(taskTone({ status: "done", is_overdue: false })).toBe("success");
  });
});

describe("misc", () => {
  it("strips PostgREST filter syntax from search terms", () => {
    expect(sanitizeSearch("  clinic,(a)*%_  b  ")).toBe("clinic a b");
    expect(sanitizeSearch("display_name.eq.x")).toBe("display name eq x");
    expect(sanitizeSearch("عيادة")).toBe("عيادة");
    expect(sanitizeSearch("x".repeat(100))).toHaveLength(60);
  });

  it("maps field-specific error codes", () => {
    expect(fieldErrorCode("NO_EMPLOYEE_PROFILE")).toBe("NO_EMPLOYEE_PROFILE");
    expect(fieldErrorCode("WORKFLOW_MISSING")).toBe("WORKFLOW_MISSING");
    expect(fieldErrorCode("PERMISSION_DENIED")).toBeNull();
    expect(fieldErrorCode(undefined)).toBeNull();
  });
});
