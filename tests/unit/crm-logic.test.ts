import { describe, expect, it } from "vitest";
import type { AppError } from "@/lib/errors";
import {
  cairoLocalToIso,
  cairoNowLocal,
  customerChanges,
  customerSearchFilter,
  duplicateCustomerNo,
  duplicateOutcome,
  formatEgyptPhone,
  groupByStage,
  lifecycleOptions,
  lifecycleTransitionAllowed,
  listQuery,
  locationFixProblem,
  locationStatus,
  nextOpportunityStages,
  normalizeEgyptPhone,
  opportunityTransitionAllowed,
  pageRange,
  parseTags,
  phoneSearchDigits,
  sanitizeSearch,
  toActionFailure,
  toLatinDigits,
  totalPages,
} from "@/modules/crm/logic";
import { LIFECYCLE_STAGES, OPPORTUNITY_STAGES, type CustomerRow, type OpportunityRow } from "@/modules/crm/types";

// Synthetic values only (D-03): no real people, clinics or phone numbers.

describe("normalizeEgyptPhone (mirror of core.to_phone_e164)", () => {
  it.each([
    ["01001234567", "+201001234567"],
    ["010 0123-4567", "+201001234567"],
    ["(010) 0123.4567", "+201001234567"],
    ["+201001234567", "+201001234567"],
    ["00201001234567", "+201001234567"],
    ["201001234567", "+201001234567"],
    ["٠١٠٠١٢٣٤٥٦٧", "+201001234567"],
    ["۰۱۰۰۱۲۳۴۵۶۷", "+201001234567"],
    ["01112345678", "+201112345678"],
    ["01223334445", "+201223334445"],
    ["01512345678", "+201512345678"],
    ["0223456789", "+20223456789"], // Cairo landline
    ["035123456", "+2035123456"], // Alexandria landline
  ])("%s → %s", (raw, e164) => {
    expect(normalizeEgyptPhone(raw)).toBe(e164);
  });

  it.each(["", "12345", "01312345678", "0100123456", "010012345678", "+14155550100", "abc", "+20 1"])("rejects %j", (raw) => {
    expect(normalizeEgyptPhone(raw)).toBeNull();
  });

  it("treats null and undefined as no phone", () => {
    expect(normalizeEgyptPhone(null)).toBeNull();
    expect(normalizeEgyptPhone(undefined)).toBeNull();
  });

  it("converts Arabic-Indic digits only", () => {
    expect(toLatinDigits("رقم ٠١٢٣٤٥٦٧٨٩")).toBe("رقم 0123456789");
  });

  it("formats E.164 back to the local form for display", () => {
    expect(formatEgyptPhone("+201001234567")).toBe("0100 123 4567");
    expect(formatEgyptPhone("+20223456789")).toBe("0223456789");
    expect(formatEgyptPhone(null)).toBe("");
  });
});

describe("customer search", () => {
  it("strips PostgREST and LIKE metacharacters", () => {
    expect(sanitizeSearch(" Sample, (Dental)*% \\ clinic ")).toBe("Sample Dental clinic");
    expect(sanitizeSearch(",,,")).toBeNull();
    expect(sanitizeSearch(undefined)).toBeNull();
    expect(sanitizeSearch("x".repeat(200))).toHaveLength(80);
  });

  it("extracts the phone digits to match inside E.164", () => {
    expect(phoneSearchDigits("0100 123")).toBe("100123");
    expect(phoneSearchDigits("+20 100 123 4567")).toBe("1001234567");
    expect(phoneSearchDigits("00201001234567")).toBe("1001234567");
    expect(phoneSearchDigits("201001234567")).toBe("1001234567");
    expect(phoneSearchDigits("٠١٠٠١٢")).toBe("10012");
    expect(phoneSearchDigits("123")).toBeNull();
    expect(phoneSearchDigits("Sample")).toBeNull();
  });

  it("builds an or-filter on names and number, plus phones for digits", () => {
    expect(customerSearchFilter("Sample")).toBe(
      'display_name.ilike."*Sample*",doctor_name.ilike."*Sample*",clinic_name.ilike."*Sample*",customer_no.ilike."*Sample*"',
    );
    const phone = customerSearchFilter("0100123");
    expect(phone).toContain('phone_primary.ilike."*100123*"');
    expect(phone).toContain('phone_secondary.ilike."*100123*"');
    expect(customerSearchFilter("  ")).toBeNull();
  });

  it("cannot inject extra filter clauses", () => {
    const filter = customerSearchFilter('x"),archived_at.not.is.null,("y') ?? "";
    expect(filter).not.toMatch(/[()]/);
    expect(filter.split(",")).toHaveLength(4);
    // Every value stays inside its own quotes.
    expect(filter.match(/"/g)).toHaveLength(8);
  });
});

describe("pagination", () => {
  it("maps a 1-based page to an inclusive range", () => {
    expect(pageRange(1)).toEqual({ from: 0, to: 24 });
    expect(pageRange(3)).toEqual({ from: 50, to: 74 });
    expect(pageRange(0)).toEqual({ from: 0, to: 24 });
    expect(pageRange(Number.NaN)).toEqual({ from: 0, to: 24 });
  });

  it("counts pages (at least one)", () => {
    expect(totalPages(0)).toBe(1);
    expect(totalPages(25)).toBe(1);
    expect(totalPages(26)).toBe(2);
    expect(totalPages(null)).toBe(1);
  });

  it("builds list URLs without empty values or page 1", () => {
    expect(listQuery({ q: "a b", stage: "", page: 1 })).toBe("?q=a+b");
    expect(listQuery({ q: undefined, stage: "lead", page: 2 })).toBe("?stage=lead&page=2");
    expect(listQuery({})).toBe("");
  });
});

describe("customer lifecycle (mirror of crm.stage_transition_allowed)", () => {
  const allowed: [string, string][] = [
    ["lead", "prospect"],
    ["lead", "active"],
    ["lead", "lost"],
    ["prospect", "lead"],
    ["prospect", "active"],
    ["prospect", "lost"],
    ["active", "dormant"],
    ["active", "lost"],
    ["dormant", "active"],
    ["dormant", "lost"],
    ["lost", "lead"],
    ["lost", "prospect"],
  ];

  it("allows exactly the database transitions", () => {
    for (const from of LIFECYCLE_STAGES) {
      for (const to of LIFECYCLE_STAGES) {
        const expected = allowed.some(([f, t]) => f === from && t === to);
        expect(lifecycleTransitionAllowed(from, to), `${from} → ${to}`).toBe(expected);
      }
    }
  });

  it("never offers blocked as a manual change, nor a way out of it", () => {
    for (const s of LIFECYCLE_STAGES) if (s !== "blocked") expect(lifecycleOptions(s)).not.toContain("blocked");
    expect(lifecycleOptions("blocked")).toEqual(["blocked"]);
  });

  it("offers the current stage first", () => {
    expect(lifecycleOptions("active")).toEqual(["active", "dormant", "lost"]);
  });
});

describe("opportunity stages (mirror of crm.opportunity_transition_allowed)", () => {
  it("open stages move anywhere else; won and lost are terminal", () => {
    for (const from of OPPORTUNITY_STAGES) {
      for (const to of OPPORTUNITY_STAGES) {
        const expected = ["new", "qualified", "proposal", "negotiation"].includes(from) && from !== to;
        expect(opportunityTransitionAllowed(from, to), `${from} → ${to}`).toBe(expected);
      }
    }
    expect(nextOpportunityStages("won")).toEqual([]);
    expect(nextOpportunityStages("new")).toEqual(["qualified", "proposal", "negotiation", "won", "lost"]);
  });

  const opp = (id: string, stage: OpportunityRow["stage"], value: number | string | null): OpportunityRow => ({
    id,
    customer_id: "c",
    customer_no: "C-0001",
    customer_name: "Sample Clinic",
    title: id,
    brand_id: null,
    brand_code: null,
    brand_name: null,
    stage,
    expected_value: value,
    probability_pct: null,
    expected_close_date: null,
    lost_reason: null,
    won_order_id: null,
    owner_employee_id: "e",
    owner_name_en: null,
    owner_name_ar: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    closed_at: null,
  });

  it("groups by stage in pipeline order with counts and expected totals", () => {
    const columns = groupByStage([opp("a", "new", 1000), opp("b", "new", "250.50"), opp("c", "won", null), opp("d", "proposal", "0.1")]);
    expect(columns.map((c) => c.stage)).toEqual([...OPPORTUNITY_STAGES]);
    expect(columns[0]).toMatchObject({ stage: "new", count: 2, expectedTotal: 1250.5 });
    expect(columns[0]?.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(columns.find((c) => c.stage === "won")).toMatchObject({ count: 1, expectedTotal: 0 });
    expect(columns.find((c) => c.stage === "qualified")).toMatchObject({ count: 0, items: [] });
  });
});

describe("customerChanges (p_changes for api.update_customer)", () => {
  const current: CustomerRow = {
    id: "40000000-0000-0000-0000-000000000001",
    customer_no: "C-0001",
    kind: "clinic",
    doctor_name: "Dr. Test",
    clinic_name: null,
    display_name: "Dr. Test",
    specialty_code: "GP",
    lifecycle_stage: "lead",
    source: "field",
    phone_primary: "+201001234567",
    phone_secondary: null,
    email: null,
    address_line: null,
    city: "Sample City",
    governorate_code: "EG-C",
    territory_id: null,
    territory_code: null,
    territory_name_en: null,
    territory_name_ar: null,
    latitude: null,
    longitude: null,
    location_verified: false,
    tags: ["b", "a"],
    notes: null,
    version: 3,
    primary_rep_employee_id: null,
    primary_rep_name_en: null,
    primary_rep_name_ar: null,
    balance: null,
    balance_updated_at: null,
    credit_limit: null,
    payment_terms_days: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    archived_at: null,
  };
  const same = {
    doctor_name: "Dr. Test",
    display_name: "Dr. Test",
    kind: "clinic",
    specialty_code: "GP",
    phone_primary: "+201001234567",
    city: " Sample City ",
    governorate_code: "eg-c",
    tags: ["a", "b", "a"],
    lifecycle_stage: "lead" as const,
  };

  it("is empty when nothing changed (whitespace, case, tag order ignored)", () => {
    expect(customerChanges(current, same)).toEqual({});
  });

  it("sends only changed fields, clearing with null", () => {
    expect(
      customerChanges(current, { ...same, clinic_name: "Sample Dental", city: undefined, tags: ["c"], lifecycle_stage: "prospect" }),
    ).toEqual({ clinic_name: "Sample Dental", city: null, tags: ["c"], lifecycle_stage: "prospect" });
  });

  it("compares phones in E.164 and sends new ones", () => {
    expect(customerChanges(current, { ...same, phone_primary: "01001234567" })).toEqual({});
    expect(customerChanges(current, { ...same, phone_primary: "+201112345678", phone_secondary: "+201223334445" })).toEqual({
      phone_primary: "+201112345678",
      phone_secondary: "+201223334445",
    });
  });

  it("does not send an unchanged or blank display name (the command recomposes it)", () => {
    expect(customerChanges(current, { ...same, display_name: "" })).toEqual({});
    expect(customerChanges(current, { ...same, display_name: "Custom Name" })).toEqual({ display_name: "Custom Name" });
  });

  it("upper-cases a changed governorate", () => {
    expect(customerChanges(current, { ...same, governorate_code: "eg-gz" })).toEqual({ governorate_code: "EG-GZ" });
  });
});

describe("parseTags", () => {
  it("splits on Latin and Arabic commas, trims, de-duplicates and sorts", () => {
    expect(parseTags(" vip, implants ،vip,, ")).toEqual(["implants", "vip"]);
    expect(parseTags(undefined)).toEqual([]);
  });
});

describe("Cairo wall-clock time", () => {
  it("converts winter time (UTC+2)", () => {
    expect(cairoLocalToIso("2026-01-15T10:30")).toBe("2026-01-15T08:30:00.000Z");
  });

  it("converts summer daylight time (UTC+3)", () => {
    expect(cairoLocalToIso("2026-07-15T10:30")).toBe("2026-07-15T07:30:00.000Z");
  });

  it("rejects malformed input", () => {
    expect(cairoLocalToIso("2026-07-15 10:30")).toBeNull();
    expect(cairoLocalToIso("")).toBeNull();
    expect(cairoLocalToIso(undefined)).toBeNull();
  });

  it("formats now as a Cairo datetime-local value", () => {
    expect(cairoNowLocal(new Date("2026-01-15T08:30:59Z"))).toBe("2026-01-15T10:30");
    expect(cairoNowLocal(new Date("2026-07-15T22:10:00Z"))).toBe("2026-07-16T01:10");
  });

  it("round-trips", () => {
    const now = new Date("2026-10-29T09:41:00Z");
    expect(cairoLocalToIso(cairoNowLocal(now))).toBe(now.toISOString());
  });
});

describe("location", () => {
  it("accepts an accurate fix inside Egypt", () => {
    expect(locationFixProblem({ lat: 30.0444, lng: 31.2357, accuracy: 12 })).toBeNull();
    expect(locationFixProblem({ lat: 30.0444, lng: 31.2357, accuracy: 100 })).toBeNull();
  });

  it("refuses an inaccurate fix", () => {
    expect(locationFixProblem({ lat: 30.0444, lng: 31.2357, accuracy: 101 })).toBe("LOCATION_INACCURATE");
    expect(locationFixProblem({ lat: 30.0444, lng: 31.2357, accuracy: Number.NaN })).toBe("LOCATION_INACCURATE");
  });

  it("refuses a fix outside the Egypt bounding box", () => {
    expect(locationFixProblem({ lat: 51.5, lng: -0.12, accuracy: 5 })).toBe("OUTSIDE_EGYPT");
  });

  it("derives the status badge", () => {
    expect(locationStatus({ latitude: null, location_verified: false })).toBe("missing");
    expect(locationStatus({ latitude: "30.044400", location_verified: false })).toBe("unverified");
    expect(locationStatus({ latitude: 30.0444, location_verified: true })).toBe("verified");
  });
});

describe("errors", () => {
  const appError = (code: string, detail: string): AppError => ({
    code,
    messageKey: "UNKNOWN",
    detail,
    retryable: false,
    requestId: "req-1",
  });

  it("extracts the existing customer number of a duplicate", () => {
    expect(duplicateCustomerNo('P0001 | DUPLICATE_CUSTOMER: phone is already registered to customer CUS-2026-000042 | {"existing_customer_no": "CUS-2026-000042"}')).toBe(
      "CUS-2026-000042",
    );
    expect(duplicateCustomerNo("P0001 | DUPLICATE_CUSTOMER: phone is already registered to customer C-0001")).toBe("C-0001");
    expect(duplicateCustomerNo("P0001 | DUPLICATE_CUSTOMER: phone is already registered to another customer")).toBeNull();
  });

  it("duplicate pre-check: a match outside the caller's scope carries no number (audit F7)", () => {
    const none = { phone_duplicate_customer_no: null, similar_count: 0, similar_customer_nos: [] };
    expect(duplicateOutcome(none)).toEqual({ kind: "none" });
    expect(duplicateOutcome({ ...none, exists_outside_scope: false, phone_duplicate_outside_scope: false, similar_outside_scope: false })).toEqual({ kind: "none" });
    expect(duplicateOutcome({ ...none, phone_duplicate_customer_no: "C-0001" })).toEqual({ kind: "phone", customerNo: "C-0001" });
    expect(duplicateOutcome({ ...none, phone_duplicate_outside_scope: true, exists_outside_scope: true })).toEqual({ kind: "phoneOutsideScope" });
    // Phone beats a similar name; a visible phone match beats a hidden one.
    expect(duplicateOutcome({ ...none, phone_duplicate_outside_scope: true, similar_count: 1, similar_customer_nos: ["C-0001"] }).kind).toBe("phoneOutsideScope");
    expect(duplicateOutcome({ ...none, similar_count: 1, similar_customer_nos: ["C-0001"] })).toEqual({
      kind: "similar",
      similar: ["C-0001"],
      similarCount: 1,
      outsideScope: false,
    });
    const hidden = duplicateOutcome({ ...none, similar_outside_scope: true, exists_outside_scope: true });
    expect(hidden).toEqual({ kind: "similar", similar: [], similarCount: 0, outsideScope: true });
  });

  it("maps CRM codes to crm.errors keys with safe values only", () => {
    const failure = toActionFailure(appError("DUPLICATE_CUSTOMER", "P0001 | phone is already registered to customer C-0001"));
    expect(failure).toEqual({ ok: false, messageKey: "UNKNOWN", crmCode: "DUPLICATE_CUSTOMER", params: { customerNo: "C-0001" }, requestId: "req-1" });
    expect(JSON.stringify(failure)).not.toContain("P0001");
  });

  it("an out-of-scope DUPLICATE_CUSTOMER becomes the 'ask your manager' code with no number", () => {
    const failure = toActionFailure(
      appError("DUPLICATE_CUSTOMER", 'P0001 | phone is already registered to a customer outside your scope | {"outside_scope": true}'),
    );
    expect(failure).toEqual({ ok: false, messageKey: "UNKNOWN", crmCode: "DUPLICATE_CUSTOMER_HIDDEN", requestId: "req-1" });
  });

  it("leaves generic codes to errors.*", () => {
    const failure = toActionFailure({ ...appError("CONFLICT", "secret detail"), messageKey: "CONFLICT" });
    expect(failure).toEqual({ ok: false, messageKey: "CONFLICT", requestId: "req-1" });
  });
});
