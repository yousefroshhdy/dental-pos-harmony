import { describe, expect, it } from "vitest";
import type { Grant } from "@/lib/authz/can";
import {
  barPercent,
  cairoToday,
  dashboardErrorCode,
  dashboardScope,
  elapsedFraction,
  isIsoDate,
  KPI_LINKS,
  KPI_UNIT,
  kpiStatus,
  maxOf,
  meterPercent,
  monthRange,
  periodHref,
  pivotBreakdown,
  pivotTeam,
  resolvePeriod,
  TARGETABLE_CODES,
  toNumber,
  valueFormat,
  workWeek,
} from "@/modules/dashboards/logic";
import { KPI_CODES } from "@/modules/dashboards/types";

describe("Cairo calendar", () => {
  it("today is the Cairo day, not the UTC day", () => {
    // 22:30 UTC on 30 Sep 2026 is 01:30 on 1 Oct in Cairo (UTC+3 in summer time)
    expect(cairoToday(new Date("2026-09-30T22:30:00Z"))).toBe("2026-10-01");
    // 21:30 UTC on 31 Dec is 23:30 in Cairo (UTC+2 in winter)
    expect(cairoToday(new Date("2026-12-31T21:30:00Z"))).toBe("2026-12-31");
  });

  it("the working week is Sunday to Thursday; Friday and Saturday show the week that just ended", () => {
    expect(workWeek("2026-10-25")).toEqual({ from: "2026-10-25", to: "2026-10-29" }); // Sunday
    expect(workWeek("2026-10-29")).toEqual({ from: "2026-10-25", to: "2026-10-29" }); // Thursday
    expect(workWeek("2026-10-30")).toEqual({ from: "2026-10-25", to: "2026-10-29" }); // Friday
    expect(workWeek("2026-10-31")).toEqual({ from: "2026-10-25", to: "2026-10-29" }); // Saturday
    expect(workWeek("2026-11-01")).toEqual({ from: "2026-11-01", to: "2026-11-05" });
  });

  it("month ranges include month ends and leap days", () => {
    expect(monthRange("2026-10-30")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(monthRange("2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2026-12-31")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("validates ISO dates strictly", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("26-2-3")).toBe(false);
    expect(isIsoDate("2026-10-01T00:00")).toBe(false);
  });
});

describe("resolvePeriod", () => {
  const today = "2026-10-28";
  it("defaults to this month", () => {
    expect(resolvePeriod({}, today)).toEqual({ kind: "month", from: "2026-10-01", to: "2026-10-31", invalid: false });
    expect(resolvePeriod({ period: "decade" }, today).kind).toBe("month");
  });
  it("today and this week", () => {
    expect(resolvePeriod({ period: "today" }, today)).toMatchObject({ from: today, to: today });
    expect(resolvePeriod({ period: ["week", "month"] }, today)).toMatchObject({ kind: "week", from: "2026-10-25", to: "2026-10-29" });
  });
  it("accepts a valid custom range and rejects bad ones", () => {
    expect(resolvePeriod({ period: "custom", from: "2026-09-01", to: "2026-09-30" }, today)).toEqual({
      kind: "custom",
      from: "2026-09-01",
      to: "2026-09-30",
      invalid: false,
    });
    expect(resolvePeriod({ period: "custom", from: "2026-09-30", to: "2026-09-01" }, today)).toMatchObject({ kind: "month", invalid: true });
    expect(resolvePeriod({ period: "custom", from: "2024-01-01", to: "2026-09-01" }, today).invalid).toBe(true);
    expect(resolvePeriod({ period: "custom", from: "x", to: "2026-09-01" }, today).invalid).toBe(true);
  });
});

describe("pace and status", () => {
  it("elapsed share of a period counts today", () => {
    expect(elapsedFraction({ from: "2026-10-01", to: "2026-10-31" }, "2026-10-15")).toBeCloseTo(15 / 31);
    expect(elapsedFraction({ from: "2026-10-01", to: "2026-10-31" }, "2026-11-02")).toBe(1);
    expect(elapsedFraction({ from: "2026-10-01", to: "2026-10-31" }, "2026-09-30")).toBe(0);
  });

  const flow = { unit: "count" as const, is_point_in_time: false, higher_is_better: true };
  it("accumulating KPIs are judged against pace", () => {
    expect(kpiStatus({ ...flow, value: 30, target: 70 }, 0.4)).toBe("onTrack"); // expected 28
    expect(kpiStatus({ ...flow, value: 24, target: 70 }, 0.4)).toBe("atRisk"); // 24/28 = 0.86
    expect(kpiStatus({ ...flow, value: 10, target: 70 }, 0.4)).toBe("behind");
    expect(kpiStatus({ ...flow, value: 70, target: 70 }, 1)).toBe("onTrack");
  });
  it("percentages are not paced; lower-is-better compares with the target", () => {
    const pct = { unit: "pct" as const, is_point_in_time: false, higher_is_better: true };
    expect(kpiStatus({ ...pct, value: 85, target: 90 }, 0.1)).toBe("atRisk");
    const lower = { unit: "hours" as const, is_point_in_time: false, higher_is_better: false };
    expect(kpiStatus({ ...lower, value: 20, target: 24 }, 0.5)).toBe("onTrack");
    expect(kpiStatus({ ...lower, value: 28, target: 24 }, 0.5)).toBe("atRisk");
    expect(kpiStatus({ ...lower, value: 40, target: 24 }, 0.5)).toBe("behind");
  });
  it("no target, no status", () => {
    expect(kpiStatus({ ...flow, value: 3, target: null }, 0.5)).toBeNull();
    expect(kpiStatus({ ...flow, value: 3, target: 0 }, 0.5)).toBeNull();
    expect(kpiStatus({ ...flow, value: null, target: 5 }, 0.5)).toBeNull();
  });
});

describe("display helpers", () => {
  it("numbers from PostgREST may be strings", () => {
    expect(toNumber("1003.20")).toBe(1003.2);
    expect(toNumber(null)).toBeNull();
    expect(toNumber("abc")).toBeNull();
  });
  it("meters and bars are clamped", () => {
    expect(meterPercent(150, 100)).toBe(100);
    expect(meterPercent(-5, 100)).toBe(0);
    expect(meterPercent(50, null)).toBe(0);
    expect(barPercent(0, 100)).toBe(0);
    expect(barPercent(1, 1000)).toBe(2);
    expect(barPercent(500, 1000)).toBe(50);
    expect(barPercent(5, 0)).toBe(0);
  });
  it("formats follow the registered unit", () => {
    expect(valueFormat("egp")).toBe("egp");
    expect(valueFormat("pct")).toBe("pct");
    expect(valueFormat("minutes")).toBe("decimal");
    expect(valueFormat("count")).toBe("count");
  });
  it("every KPI has a unit; targets exclude live operational counts", () => {
    expect(Object.keys(KPI_UNIT).sort()).toEqual([...KPI_CODES].sort());
    expect(TARGETABLE_CODES).not.toContain("STOCK_ALERTS");
    expect(TARGETABLE_CODES).not.toContain("PENDING_APPROVALS");
    expect(TARGETABLE_CODES).toContain("BOOKED_SALES");
  });
  it("tile links stay inside the app", () => {
    for (const href of Object.values(KPI_LINKS)) expect(href).toMatch(/^\/[a-z]/);
    expect(KPI_LINKS.AR_OVERDUE).toBe("/finance/aging");
    expect(KPI_LINKS.NET_REVENUE).toBe("/finance/invoices");
  });
  it("period links keep the custom range and the employee filter", () => {
    expect(periodHref({ kind: "month", from: "2026-10-01", to: "2026-10-31" })).toBe("/dashboard?period=month");
    expect(periodHref({ kind: "custom", from: "2026-09-01", to: "2026-09-30" }, { employee: "e1" })).toBe(
      "/dashboard?period=custom&from=2026-09-01&to=2026-09-30&employee=e1",
    );
  });
});

describe("pivots", () => {
  it("team rows pivot by employee, keeping server order", () => {
    const rows = [
      { employee_id: "b", employee_no: "E2", full_name_en: "B", full_name_ar: null, kpi_code: "ORDERS_BOOKED", value: 2, target: null, achievement_pct: null },
      { employee_id: "a", employee_no: "E1", full_name_en: "A", full_name_ar: "أ", kpi_code: "ORDERS_BOOKED", value: 1, target: 4, achievement_pct: 25 },
      { employee_id: "b", employee_no: "E2", full_name_en: "B", full_name_ar: null, kpi_code: "BOOKED_SALES", value: "100.00", target: null, achievement_pct: null },
    ];
    const team = pivotTeam(rows);
    expect(team.map((m) => m.employee_id)).toEqual(["b", "a"]);
    expect(team[0]?.kpis.BOOKED_SALES?.value).toBe("100.00");
    expect(team[1]?.kpis.ORDERS_BOOKED?.achievement_pct).toBe(25);
  });
  it("breakdown rows pivot by dimension with numeric values", () => {
    const entries = pivotBreakdown([
      { dimension_id: "t1", dimension_code: "CAI", name_en: "Cairo", name_ar: null, kpi_code: "BOOKED_SALES", value: "2460.00" },
      { dimension_id: "t2", dimension_code: "DELTA", name_en: "Delta", name_ar: null, kpi_code: "BOOKED_SALES", value: 3000 },
      { dimension_id: "t1", dimension_code: "CAI", name_en: "Cairo", name_ar: null, kpi_code: "AR_OVERDUE", value: null },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.values).toEqual({ BOOKED_SALES: 2460, AR_OVERDUE: 0 });
    expect(maxOf(entries, "BOOKED_SALES")).toBe(3000);
  });
});

describe("scope and errors", () => {
  const ctx = (scope?: Grant["scope"], is_owner = false): { is_owner: boolean; permissions: Record<string, Grant> } => ({
    is_owner,
    permissions: scope ? { "perf.kpi.read": { scope, limit: null } } : {},
  });
  it("maps perf.kpi.read scope to the dashboard", () => {
    expect(dashboardScope(ctx("own"))).toBe("own");
    expect(dashboardScope(ctx("team"))).toBe("team");
    expect(dashboardScope(ctx("territory"))).toBe("team");
    expect(dashboardScope(ctx("all"))).toBe("all");
    expect(dashboardScope(ctx(undefined, true))).toBe("all");
    expect(dashboardScope(ctx())).toBeNull();
  });
  it("unknown error codes fall back to UNKNOWN", () => {
    expect(dashboardErrorCode({ code: "PERMISSION_DENIED" })).toBe("PERMISSION_DENIED");
    expect(dashboardErrorCode({ code: "SOMETHING_ELSE" })).toBe("UNKNOWN");
  });
});
