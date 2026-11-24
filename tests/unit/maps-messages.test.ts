import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MESSAGE_MODULES } from "@/i18n/modules";
import { mapsNav } from "@/modules/maps/nav";
import { LAST_VISIT_FILTERS, MAPS_ERROR_CODES, PROPOSAL_STATUSES } from "@/modules/maps/types";

const load = (locale: string) =>
  JSON.parse(readFileSync(join(__dirname, "../../messages", locale, "maps.json"), "utf8")) as Record<string, Record<string, unknown>>;

// Every verification status of field.visits (CHECK constraint) has a label on the day map.
const VERIFICATION = [
  "pending",
  "verified",
  "out_of_range",
  "low_accuracy",
  "no_customer_location",
  "no_device_location",
  "exception_requested",
  "exception_approved",
  "exception_rejected",
];

/** Every value the maps UI shows has a label (ar/en key parity is checked in module-messages.test.ts). */
describe.each(["ar", "en"])("maps messages (%s)", (locale) => {
  const m = load(locale);
  const keysOf = (path: string) => Object.keys(path.split(".").reduce<Record<string, unknown>>((n, k) => n[k] as Record<string, unknown>, m)).sort();

  it("is registered as a message module", () => {
    expect(MESSAGE_MODULES).toContain("maps");
  });

  it.each([
    ["errors", MAPS_ERROR_CODES],
    ["proposals.status", PROPOSAL_STATUSES],
    ["customers.filters.visit", LAST_VISIT_FILTERS],
    ["day.verification", VERIFICATION],
    ["customer.geo", ["denied", "unavailable", "timeout", "unsupported"]],
    ["visitFlags", ["clock_skew", "impossible_travel", "duplicate_fix", "late_sync"]],
  ] as const)("labels every value of %s", (path, values) => {
    expect(keysOf(path)).toEqual([...values].sort());
  });

  it("labels each nav entry", () => {
    const nav = m.nav as Record<string, string>;
    for (const item of mapsNav) expect(typeof nav[item.labelKey.replace("maps.nav.", "")]).toBe("string");
  });

  it("names the missing key in the no-key state", () => {
    expect((m.map as Record<string, string>).noKeyBody).toContain("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY");
  });

  it("uses Western digits only (D-11)", () => {
    expect(JSON.stringify(m)).not.toMatch(/[٠-٩]/);
  });
});

describe("maps nav", () => {
  it("gates each map on its permission", () => {
    expect(mapsNav).toEqual([
      { href: "/map", labelKey: "maps.nav.map", permission: "crm.customer.read" },
      { href: "/map/team", labelKey: "maps.nav.team", permission: "field.tracking.read" },
      { href: "/map/proposals", labelKey: "maps.nav.proposals", permission: "crm.customer_location.verify" },
    ]);
  });
});
