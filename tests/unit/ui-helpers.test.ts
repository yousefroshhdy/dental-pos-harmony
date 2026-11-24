import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { pageRange, readTableParams, tableStateToQuery } from "@/components/ui/data-table-params";
import { cairoIsoDate, formatIsoDate, isoInRange, parseIsoDate } from "@/components/ui/date-utils";
import { VALIDATION_KEYS, validationMessage } from "@/components/ui/form-messages";
import { initialsOf } from "@/components/app-shell/initials";

describe("date picker helpers (Cairo calendar, Western digits)", () => {
  it("parses only real ISO dates", () => {
    expect(parseIsoDate("2026-11-24")).toEqual({ year: 2026, month: 11, day: 24 });
    expect(parseIsoDate("2026-02-30")).toBeNull();
    expect(parseIsoDate("24/11/2026")).toBeNull();
    expect(parseIsoDate(null)).toBeNull();
  });

  it("an instant's Cairo date, across midnight UTC", () => {
    // 22:30 UTC on 24 Nov is already 25 Nov in Cairo (UTC+2).
    expect(cairoIsoDate(new Date("2026-11-24T22:30:00Z"))).toBe("2026-11-25");
    expect(cairoIsoDate(new Date("2026-11-24T21:30:00Z"))).toBe("2026-11-24");
  });

  it("formats with Latin digits in Arabic", () => {
    const ar = formatIsoDate("2026-11-24", "ar");
    expect(ar).toMatch(/24/);
    expect(ar).toMatch(/2026/);
    expect(ar).not.toMatch(/[٠-٩]/);
    expect(formatIsoDate("2026-11-24", "en")).toBe("Nov 24, 2026");
    expect(formatIsoDate("not-a-date", "en")).toBe("not-a-date");
  });

  it("range check", () => {
    expect(isoInRange("2026-11-24", "2026-11-01", "2026-11-30")).toBe(true);
    expect(isoInRange("2026-12-01", "2026-11-01", "2026-11-30")).toBe(false);
    expect(isoInRange("2026-10-31", "2026-11-01")).toBe(false);
  });
});

describe("server DataTable URL state", () => {
  const opts = { pageSize: 25, sortable: ["display_name", "created_at"] as const };

  it("reads page, sort and search, ignoring unknown sort columns", () => {
    expect(readTableParams({ page: "3", sort: "-created_at", q: "  clinic  " }, opts)).toEqual({
      pageIndex: 2,
      pageSize: 25,
      sorting: [{ id: "created_at", desc: true }],
      search: "clinic",
      offset: 50,
    });
    expect(readTableParams({ sort: "password_hash" }, opts).sorting).toEqual([]);
    expect(readTableParams({ sort: "x" }, { ...opts, defaultSort: { id: "display_name", desc: false } }).sorting).toEqual([{ id: "display_name", desc: false }]);
  });

  it("clamps bad pages", () => {
    expect(readTableParams({ page: "0" }, opts).pageIndex).toBe(0);
    expect(readTableParams({ page: "-4" }, opts).pageIndex).toBe(0);
    expect(readTableParams({ page: "abc" }, opts).pageIndex).toBe(0);
    expect(readTableParams({ page: "99999999" }, opts).pageIndex).toBe(9_999);
    expect(readTableParams({ q: "x".repeat(500) }, opts).search).toHaveLength(100);
  });

  it("writes the query, keeping other filters and omitting defaults", () => {
    const q = tableStateToQuery({ pageIndex: 0, pageSize: 25, sorting: [], search: "" }, { stage: "prospect", page: "4" });
    expect(q.toString()).toBe("stage=prospect");
    const q2 = tableStateToQuery({ pageIndex: 1, pageSize: 25, sorting: [{ id: "display_name", desc: false }], search: "عيادة" }, new URLSearchParams("stage=active"));
    expect(Object.fromEntries(q2)).toEqual({ stage: "active", q: "عيادة", sort: "display_name", page: "2" });
  });

  it("round-trips", () => {
    const state = { pageIndex: 4, pageSize: 25, sorting: [{ id: "created_at", desc: true }], search: "x" };
    const { offset, ...back } = readTableParams(tableStateToQuery(state), opts);
    expect(back).toEqual(state);
    expect(offset).toBe(100);
  });

  it("page range", () => {
    expect(pageRange(0, 25, 0)).toEqual({ from: 0, to: 0, pages: 1 });
    expect(pageRange(0, 25, 7)).toEqual({ from: 1, to: 7, pages: 1 });
    expect(pageRange(1, 25, 60)).toEqual({ from: 26, to: 50, pages: 3 });
    expect(pageRange(2, 25, 60)).toEqual({ from: 51, to: 60, pages: 3 });
  });
});

describe("inline validation messages", () => {
  const issue = (schema: z.ZodType, value: unknown) => {
    const r = schema.safeParse(value);
    if (r.success) throw new Error("expected a failure");
    return r.error.issues[0]!;
  };

  it("maps common zod issues to the shared form.* keys", () => {
    expect(validationMessage(issue(z.string(), undefined))).toEqual({ key: "required" });
    expect(validationMessage(issue(z.string().min(1), ""))).toEqual({ key: "required" });
    expect(validationMessage(issue(z.string().min(3), "ab"))).toEqual({ key: "tooShort", values: { min: 3 } });
    expect(validationMessage(issue(z.string().max(5), "abcdefg"))).toEqual({ key: "tooLong", values: { max: 5 } });
    expect(validationMessage(issue(z.email(), "nope"))).toEqual({ key: "email" });
    expect(validationMessage(issue(z.number(), "x"))).toEqual({ key: "number" });
    expect(validationMessage(issue(z.number(), undefined))).toEqual({ key: "required" });
    expect(validationMessage(issue(z.number(), ""), { value: "" })).toEqual({ key: "required" });
    expect(validationMessage({ code: "invalid_type", expected: "number" }, { value: "12a" })).toEqual({ key: "number" });
    expect(validationMessage(issue(z.number().min(1), 0))).toEqual({ key: "min", values: { min: 1 } });
    expect(validationMessage(issue(z.number().max(100), 101))).toEqual({ key: "max", values: { max: 100 } });
    expect(validationMessage(issue(z.number().int(), 1.5))).toMatchObject({ key: expect.stringMatching(/^(integer|number|invalid)$/) });
    expect(validationMessage({ code: "custom" })).toEqual({ key: "invalid" });
  });

  it.each(["ar", "en"])("%s has every message, with the placeholders it needs", (locale) => {
    const form = JSON.parse(readFileSync(join(__dirname, "../../messages", `${locale}.json`), "utf8")).form as Record<string, string>;
    for (const key of VALIDATION_KEYS) expect(form[key], key).toEqual(expect.any(String));
    expect(form.tooShort).toContain("{min}");
    expect(form.tooLong).toContain("{max}");
    expect(form.min).toContain("{min}");
    expect(form.max).toContain("{max}");
  });
});

describe("user menu initials", () => {
  it.each([
    ["Sara Ali Hassan", "SA"],
    ["مندوب تجريبي", "مت"],
    ["  single  ", "S"],
    ["", ""],
  ])("%s → %s", (name, expected) => {
    expect(initialsOf(name)).toBe(expected);
  });
});
