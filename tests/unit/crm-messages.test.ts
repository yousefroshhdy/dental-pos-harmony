import { describe, expect, it } from "vitest";
import ar from "../../messages/ar/crm.json";
import en from "../../messages/en/crm.json";
import {
  ACTIVITY_TYPES,
  CRM_ERROR_CODES,
  CUSTOMER_KINDS,
  CUSTOMER_SOURCES,
  LIFECYCLE_STAGES,
  OPPORTUNITY_STAGES,
} from "@/modules/crm/types";

// Keys built from enums at runtime (tStage(stage) etc.) are not visible to a
// static check, so each enum must have a label in both languages.
describe.each([
  ["en", en],
  ["ar", ar],
])("crm.json (%s) labels every enum value", (_locale, messages) => {
  it.each([
    ["stage", LIFECYCLE_STAGES],
    ["kind", CUSTOMER_KINDS],
    ["source", CUSTOMER_SOURCES],
    ["activityType", ACTIVITY_TYPES],
    ["opportunityStage", OPPORTUNITY_STAGES],
    ["errors", CRM_ERROR_CODES],
  ] as const)("%s", (group, values) => {
    const labels = messages[group] as Record<string, string>;
    expect(Object.keys(labels).sort()).toEqual([...values].sort());
  });

  it("has a message for every geolocation failure", () => {
    expect(Object.keys(messages.location.error).sort()).toEqual(["denied", "timeout", "unavailable", "unsupported"]);
  });

  it("nav labels match the nav entries", () => {
    expect(Object.keys(messages.nav).sort()).toEqual(["customers", "opportunities"]);
  });
});
