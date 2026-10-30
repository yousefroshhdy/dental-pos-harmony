import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NATIVE_PROBLEM_KEYS, TRACKING_ERROR_CODES } from "@/modules/tracking/logic";
import { trackingNav } from "@/modules/tracking/nav";
import { DAY_FLAGS, PING_FLAGS, SHIFT_STATUSES } from "@/modules/tracking/types";

const load = (locale: string) =>
  JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "tracking.json"), "utf8")) as Record<string, Record<string, unknown>>;

/** Every value the UI shows has a label (ar/en key parity is checked in module-messages.test.ts). */
describe.each(["ar", "en"])("tracking messages (%s)", (locale) => {
  const m = load(locale);
  const keysOf = (path: string) => Object.keys(path.split(".").reduce<Record<string, unknown>>((n, k) => n[k] as Record<string, unknown>, m));

  it.each([
    ["flags", DAY_FLAGS],
    ["pingFlags", PING_FLAGS],
    ["shiftStatus", SHIFT_STATUSES],
    ["errors", TRACKING_ERROR_CODES],
    ["shift.geo", ["denied", "unavailable", "timeout", "unsupported", "insecure"]],
    ["native.problem", NATIVE_PROBLEM_KEYS],
  ] as const)("labels every value of %s", (path, values) => {
    expect(keysOf(path).sort()).toEqual([...values].sort());
  });

  it("has the nav label, gated on field.tracking.read", () => {
    expect(trackingNav).toEqual([{ href: "/tracking", labelKey: "tracking.nav.tracking", permission: "field.tracking.read" }]);
    expect(typeof m.nav?.tracking).toBe("string");
  });

  it("tells the rep honestly about the browser limit", () => {
    const shift = m.shift as Record<string, string>;
    expect(shift.browserLimit).toMatch(locale === "en" ? /open with the screen on/ : /مفتوح والشاشة مضاءة/);
  });

  it("the Android notification says what is recorded and why (D-14 transparency)", () => {
    const native = m.native as Record<string, unknown>;
    expect(native.notificationMessage).toMatch(locale === "en" ? /recording your location for your working day/ : /يسجّل .* موقعك خلال يوم عملك/);
    expect(typeof native.notificationTitle).toBe("string");
  });
});

describe("auth messages for the sign-in code", () => {
  it.each(["ar", "en"])("%s has every key, none empty", (locale) => {
    const auth = (JSON.parse(readFileSync(join(__dirname, "../../messages", `${locale}.json`), "utf8")) as { auth: Record<string, string> }).auth;
    for (const key of ["otpSend", "otpSent", "otpCode", "otpHint", "otpVerify", "otpInvalid"]) expect(auth[key]?.trim()).toBeTruthy();
  });
});
