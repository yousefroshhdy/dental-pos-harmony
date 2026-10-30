import { describe, expect, it } from "vitest";
import { parseCommissionRun } from "@/modules/commissions/cron";
import {
  addMonths,
  cairoToday,
  closableMonth,
  commissionErrorCode,
  displayStatus,
  isFrozen,
  isMonthKey,
  kindMatchesSign,
  kindTone,
  monthEnd,
  monthStart,
  parseSignedAmount,
  periodRows,
  recalculableMonths,
  recentMonths,
  requestTone,
  resolveMonth,
  sortLines,
  statusTone,
  sumSummary,
  toNumber,
} from "@/modules/commissions/logic";
import type { PeriodRow, PeriodStatus, StatementLine } from "@/modules/commissions/types";

const period = (start: string, status: PeriodStatus): PeriodRow => ({
  id: start,
  period_start: start,
  period_end: monthEnd(start.slice(0, 7)),
  status,
  is_frozen: isFrozen(status),
  closes_at: "2026-01-06T00:00:00+02:00",
  calculated_at: null,
  closed_at: null,
  entries_total: 0,
  entry_count: 0,
  adjustments_total: 0,
  total: 0,
  employee_count: 0,
});

describe("months", () => {
  it("Cairo today crosses midnight in Cairo, not UTC", () => {
    expect(cairoToday(new Date("2026-10-31T22:30:00Z"))).toBe("2026-11-01");
    expect(cairoToday(new Date("2026-10-31T20:30:00Z"))).toBe("2026-10-31");
  });

  it("validates, starts, ends and shifts month keys", () => {
    expect(isMonthKey("2026-06")).toBe(true);
    expect(isMonthKey("2026-13")).toBe(false);
    expect(isMonthKey("2026-6")).toBe(false);
    expect(isMonthKey("1999-12")).toBe(false);
    expect(monthStart("2026-06")).toBe("2026-06-01");
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(monthEnd("2028-02")).toBe("2028-02-29");
    expect(monthEnd("2026-12")).toBe("2026-12-31");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-11", 3)).toBe("2027-02");
  });

  it("resolves ?period= to a month no later than the current one", () => {
    expect(resolveMonth(undefined, "2026-10-30")).toBe("2026-10");
    expect(resolveMonth("2026-06", "2026-10-30")).toBe("2026-06");
    expect(resolveMonth(["2026-05", "2026-04"], "2026-10-30")).toBe("2026-05");
    expect(resolveMonth("2027-01", "2026-10-30")).toBe("2026-10");
    expect(resolveMonth("june", "2026-10-30")).toBe("2026-10");
  });

  it("lists recent months newest first", () => {
    expect(recentMonths("2026-02-10", 4)).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"]);
    expect(recentMonths("2026-02-10", 0)).toEqual(["2026-02"]);
  });
});

describe("period state", () => {
  it("approved, paid and locked months are frozen", () => {
    expect(["open", "calculated", "approved", "paid", "locked"].map((s) => isFrozen(s as PeriodStatus))).toEqual([false, false, true, true, true]);
    expect(displayStatus(null)).toBe("open");
    expect(displayStatus("calculated")).toBe("calculated");
    expect(displayStatus("paid")).toBe("closed");
    expect(statusTone("approved")).toBe("success");
    expect(statusTone("calculated")).toBe("info");
    expect(statusTone(undefined)).toBe("neutral");
  });

  it("the closable month is the oldest open one, once it ended", () => {
    const today = "2026-10-30";
    expect(closableMonth([], today)).toBeNull();
    expect(closableMonth([period("2026-10-01", "calculated")], today)).toBeNull();
    expect(closableMonth([period("2026-08-01", "calculated"), period("2026-09-01", "open")], today)).toBe("2026-08");
    expect(closableMonth([period("2026-07-01", "approved"), period("2026-09-01", "calculated")], today)).toBe("2026-08");
    expect(closableMonth([period("2026-09-01", "approved")], today)).toBeNull();
  });

  it("recalculable months run from the oldest open month to the current one", () => {
    const today = "2026-10-30";
    expect(recalculableMonths([], today)).toEqual(["2026-10"]);
    expect(recalculableMonths([period("2026-07-01", "approved"), period("2026-09-01", "calculated")], today)).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(recalculableMonths([period("2026-10-01", "approved")], today)).toEqual([]);
  });

  it("the periods list always shows the current month", () => {
    const rows = periodRows([period("2026-08-01", "approved")], "2026-10-30");
    expect(rows.map((r) => r.period_start)).toEqual(["2026-10-01", "2026-08-01"]);
    expect(rows[0] !== undefined && "missing" in rows[0]).toBe(true);
    expect(periodRows([period("2026-10-01", "calculated")], "2026-10-30")).toHaveLength(1);
  });
});

describe("amounts and lines", () => {
  it("parses signed amounts with at most 2 decimals, Arabic digits too", () => {
    expect(parseSignedAmount("250")).toBe(250);
    expect(parseSignedAmount("-250.5")).toBe(-250.5);
    expect(parseSignedAmount("−12.25")).toBe(-12.25);
    expect(parseSignedAmount("١٬٢٥٠٫٧٥")).toBe(1250.75);
    expect(parseSignedAmount("1,000")).toBe(1000);
    expect(parseSignedAmount("0")).toBeNull();
    expect(parseSignedAmount("1.234")).toBeNull();
    expect(parseSignedAmount("abc")).toBeNull();
    expect(parseSignedAmount("2000000")).toBeNull();
  });

  it("a bonus is positive, a clawback negative, a correction anything but zero", () => {
    expect(kindMatchesSign("bonus", 10)).toBe(true);
    expect(kindMatchesSign("bonus", -10)).toBe(false);
    expect(kindMatchesSign("clawback", -10)).toBe(true);
    expect(kindMatchesSign("clawback", 10)).toBe(false);
    expect(kindMatchesSign("correction", -10)).toBe(true);
    expect(kindMatchesSign("correction", 0)).toBe(false);
  });

  it("tones by line kind and request status", () => {
    expect(kindTone("collection")).toBe("success");
    expect(kindTone("credit_reattribution")).toBe("success");
    expect(kindTone("bounce")).toBe("danger");
    expect(kindTone("credit_clawback")).toBe("danger");
    expect(kindTone("bonus")).toBe("info");
    expect(kindTone("correction")).toBe("warning");
    expect(requestTone("pending")).toBe("warning");
    expect(requestTone("rejected")).toBe("danger");
    expect(requestTone("expired")).toBe("neutral");
  });

  it("toNumber accepts PostgREST numerics", () => {
    expect(toNumber("49.00")).toBe(49);
    expect(toNumber(-25)).toBe(-25);
    expect(toNumber(null)).toBeNull();
    expect(toNumber("x")).toBeNull();
  });

  it("sums team rows in whole cents", () => {
    const rows = [
      { earned: "0.10", clawed_back: "-0.20", adjustments: 0, total: "-0.10" },
      { earned: 0.2, clawed_back: 0, adjustments: "100.00", total: 100.2 },
    ];
    expect(sumSummary(rows)).toEqual({ earned: 0.3, clawed: -0.2, adjustments: 100, total: 100.1 });
  });

  it("sorts statement lines newest first, stable by id", () => {
    const line = (id: string, at: string) => ({ id, event_at: at }) as StatementLine;
    expect(sortLines([line("b", "2026-06-01T10:00:00Z"), line("c", "2026-06-02T10:00:00Z"), line("a", "2026-06-01T10:00:00Z")]).map((l) => l.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});

describe("errors and the cron summary", () => {
  it("maps command errors to commission messages", () => {
    expect(commissionErrorCode({ code: "PERIOD_CLOSED" })).toBe("PERIOD_CLOSED");
    expect(commissionErrorCode({ code: "PREVIOUS_PERIOD_OPEN" })).toBe("PREVIOUS_PERIOD_OPEN");
    expect(commissionErrorCode({ code: "SELF_ADJUSTMENT", messageKey: "UNKNOWN" })).toBe("SELF_ADJUSTMENT");
    expect(commissionErrorCode({ code: "SOMETHING_ELSE", messageKey: "PERMISSION_DENIED" })).toBe("PERMISSION_DENIED");
    expect(commissionErrorCode({ code: "SOMETHING_ELSE" })).toBe("UNKNOWN");
  });

  it("parses service.commission_run defensively", () => {
    expect(parseCommissionRun({ closed: ["2026-09"], calculated: ["2026-10"], changed: 1 })).toEqual({ closed: ["2026-09"], calculated: ["2026-10"], changed: 1 });
    expect(parseCommissionRun({ closed: ["bad", 3], calculated: null, changed: -1 })).toEqual({ closed: [], calculated: [], changed: 0 });
    expect(parseCommissionRun(null)).toEqual({ closed: [], calculated: [], changed: 0 });
  });
});
