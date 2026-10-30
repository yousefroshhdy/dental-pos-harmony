import { describe, expect, it } from "vitest";
import { ANONYMOUS_CONTEXT, type UserContext } from "@/lib/authz/can";
import {
  addDays,
  addMonths,
  cairoToday,
  canPlan,
  canPlanTeam,
  canSeeCoverage,
  canSetFrequency,
  coveragePct,
  dayOfWeek,
  defaultPlanDay,
  groupByDay,
  groupProposals,
  monthOf,
  parseCoverageFilter,
  parseDay,
  parseMonth,
  parseProposalValue,
  pickEmployee,
  planningErrorCode,
  proposalValue,
  sortCoverage,
  sortEmployees,
  visibleDays,
  weekDates,
  weekStartOf,
} from "@/modules/planning/logic";
import type { CoverageRow, PlanningEmployee, PlanRow, Proposal } from "@/modules/planning/types";

const WORK = ["sun", "mon", "tue", "wed", "thu"] as const;

function ctx(permissions: UserContext["permissions"], extra: Partial<UserContext> = {}): UserContext {
  return { ...ANONYMOUS_CONTEXT, user_id: "u", active: true, status: "active", permissions, ...extra };
}

const plan = (over: Partial<PlanRow>): PlanRow => ({
  id: "v",
  employee_id: "e",
  employee_name_en: null,
  employee_name_ar: null,
  customer_id: "c",
  customer_no: "C-1",
  customer_name: "Synthetic",
  visit_class: "C",
  planned_for: "2026-11-01",
  week_start: "2026-11-01",
  day_of_week: 0,
  status: "planned",
  verification_status: "pending",
  check_in_at: null,
  check_out_at: null,
  outcome: null,
  can_unplan: true,
  is_missed: false,
  created_at: "2026-10-30T10:00:00Z",
  ...over,
});

const cov = (over: Partial<CoverageRow>): CoverageRow => ({
  customer_id: "c",
  customer_no: "C-1",
  customer_name: "Synthetic",
  territory_id: null,
  lifecycle_stage: "active",
  employee_id: "e",
  employee_name_en: "Rep",
  employee_name_ar: null,
  visit_class: "C",
  class_is_default: true,
  interval_days: 30,
  period_start: "2026-10-01",
  period_end: "2026-10-31",
  target_visits: 1,
  actual_visits: 0,
  target_met: false,
  last_visit_on: null,
  days_since_last_visit: null,
  next_due_on: "2026-10-30",
  is_overdue: true,
  overdue_days: null,
  next_planned_on: null,
  ...over,
});

const emp = (over: Partial<PlanningEmployee>): PlanningEmployee => ({
  id: "e",
  employee_no: "E1",
  full_name_en: "Someone",
  full_name_ar: null,
  job_title: "Rep",
  is_me: false,
  ...over,
});

describe("permissions (UX only)", () => {
  it("a rep plans for self; team scope plans for others", () => {
    const rep = ctx({ "field.visit.plan": { scope: "own", limit: null }, "field.visit.read": { scope: "own", limit: null } });
    expect(canPlan(rep)).toBe(true);
    expect(canPlanTeam(rep)).toBe(false);
    expect(canSeeCoverage(rep)).toBe(true);
    const mgr = ctx({ "field.visit.plan": { scope: "team", limit: null } });
    expect(canPlanTeam(mgr)).toBe(true);
  });

  it("visit frequency needs crm.customer.update at team scope or wider", () => {
    expect(canSetFrequency(ctx({ "crm.customer.update": { scope: "own", limit: null } }))).toBe(false);
    expect(canSetFrequency(ctx({ "crm.customer.update": { scope: "territory", limit: null } }))).toBe(true);
    expect(canSetFrequency(ctx({}, { is_owner: true }))).toBe(true);
    expect(canPlan(ANONYMOUS_CONTEXT)).toBe(false);
  });
});

describe("error codes", () => {
  it("maps planning codes and leaves the rest to the shared errors", () => {
    expect(planningErrorCode("PAST_DATE")).toBe("PAST_DATE");
    expect(planningErrorCode("NOT_ASSIGNED")).toBe("NOT_ASSIGNED");
    expect(planningErrorCode("PERMISSION_DENIED")).toBeNull();
    expect(planningErrorCode(undefined)).toBeNull();
  });
});

describe("days, weeks and months", () => {
  it("parses real calendar days and months only", () => {
    expect(parseDay("2026-11-05")).toBe("2026-11-05");
    expect(parseDay(["2026-11-05"])).toBe("2026-11-05");
    expect(parseDay("2026-02-30")).toBeNull();
    expect(parseDay("5/11/2026")).toBeNull();
    expect(parseDay(undefined)).toBeNull();
    expect(parseMonth("2026-12")).toBe("2026-12-01");
    expect(parseMonth("2026-13")).toBeNull();
  });

  it("today is the Cairo day", () => {
    // 22:30 UTC on 31 Oct is already 1 Nov in Cairo (UTC+2 in winter).
    expect(cairoToday(new Date("2026-10-31T22:30:00Z"))).toBe("2026-11-01");
    expect(cairoToday(new Date("2026-10-31T12:00:00Z"))).toBe("2026-10-31");
  });

  it("weeks start on Sunday", () => {
    expect(dayOfWeek("2026-11-01")).toBe(0); // a Sunday
    expect(weekStartOf("2026-11-05")).toBe("2026-11-01");
    expect(weekStartOf("2026-11-07")).toBe("2026-11-01"); // Saturday
    expect(weekStartOf("2026-11-01")).toBe("2026-11-01");
    expect(weekDates("2026-11-01")).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
    ]);
  });

  it("adds days and months across boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(monthOf("2026-11-05")).toBe("2026-11");
  });

  it("shows the working days, plus a day off only when it has visits", () => {
    expect(visibleDays("2026-11-01", WORK, [])).toHaveLength(5);
    expect(visibleDays("2026-11-01", WORK, [plan({ planned_for: "2026-11-07" })])).toContain("2026-11-07");
    expect(visibleDays("2026-11-01", ["mon", "wed"], [])).toEqual(["2026-11-02", "2026-11-04"]);
  });

  it("defaults a new visit to the first working day from today", () => {
    expect(defaultPlanDay("2026-11-01", "2026-11-03", WORK)).toBe("2026-11-03");
    expect(defaultPlanDay("2026-11-01", "2026-11-06", WORK)).toBe("2026-11-06"); // Friday: no working day left
    expect(defaultPlanDay("2026-11-08", "2026-11-03", WORK)).toBe("2026-11-08"); // a future week
    expect(defaultPlanDay("2026-10-25", "2026-11-03", WORK)).toBe("2026-11-03"); // a past week
  });
});

describe("week grid", () => {
  it("groups by day and sorts by customer name", () => {
    const g = groupByDay(
      [plan({ id: "1", customer_name: "Zeta" }), plan({ id: "2", customer_name: "Alpha" }), plan({ id: "3", planned_for: "2026-11-02" })],
      "en",
    );
    expect(g.get("2026-11-01")?.map((r) => r.id)).toEqual(["2", "1"]);
    expect(g.get("2026-11-02")).toHaveLength(1);
  });

  it("picks the requested employee only if the caller may plan for them", () => {
    const list = [emp({ id: "me", is_me: true }), emp({ id: "rep" })];
    expect(pickEmployee(list, "rep")?.id).toBe("rep");
    expect(pickEmployee(list, "stranger")?.id).toBe("me");
    expect(pickEmployee(list, undefined)?.id).toBe("me");
    expect(pickEmployee([], "rep")).toBeNull();
  });

  it("lists me first, then by name", () => {
    const sorted = sortEmployees([emp({ id: "b", full_name_en: "Bee" }), emp({ id: "a", full_name_en: "Ay" }), emp({ id: "me", full_name_en: "Zed", is_me: true })], "en");
    expect(sorted.map((e) => e.id)).toEqual(["me", "a", "b"]);
  });
});

describe("generated plan review", () => {
  const p = (customer_id: string, date: string): Proposal => ({
    customer_id,
    customer_no: customer_id,
    customer_name: customer_id,
    visit_class: "A",
    date,
    due_on: date,
    last_visit_on: null,
    reason: "never_visited",
  });

  it("round-trips the checkbox value", () => {
    const v = proposalValue({ customer_id: "42000000-0000-0000-0000-000000000001", date: "2026-11-02" });
    expect(parseProposalValue(v)).toEqual({ customer_id: "42000000-0000-0000-0000-000000000001", date: "2026-11-02" });
    expect(parseProposalValue("x|2026-02-30")).toBeNull();
    expect(parseProposalValue("x|2026-11-02|y")).toBeNull();
    expect(parseProposalValue("nothing")).toBeNull();
  });

  it("groups proposals by day in date order", () => {
    const g = groupProposals([p("b", "2026-11-03"), p("a", "2026-11-02"), p("c", "2026-11-03")]);
    expect(g.map((d) => [d.date, d.items.length])).toEqual([
      ["2026-11-02", 1],
      ["2026-11-03", 2],
    ]);
  });
});

describe("coverage", () => {
  it("never visited first, then most days overdue, then the rest", () => {
    const rows = sortCoverage(
      [
        cov({ customer_id: "ok", customer_name: "A", is_overdue: false, last_visit_on: "2026-10-20", overdue_days: 0 }),
        cov({ customer_id: "late3", customer_name: "B", last_visit_on: "2026-10-01", overdue_days: 3 }),
        cov({ customer_id: "never", customer_name: "C" }),
        cov({ customer_id: "late9", customer_name: "D", last_visit_on: "2026-09-01", overdue_days: 9 }),
      ],
      "en",
    );
    expect(rows.map((r) => r.customer_id)).toEqual(["never", "late9", "late3", "ok"]);
  });

  it("parses the filter and caps the progress", () => {
    expect(parseCoverageFilter("all")).toBe("all");
    expect(parseCoverageFilter("anything")).toBe("overdue");
    expect(coveragePct({ actual_visits: 1, target_visits: 4 })).toBe(25);
    expect(coveragePct({ actual_visits: 6, target_visits: 4 })).toBe(100);
    expect(coveragePct({ actual_visits: 0, target_visits: 0 })).toBe(100);
  });
});
