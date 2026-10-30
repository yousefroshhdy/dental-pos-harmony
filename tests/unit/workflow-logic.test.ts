import { describe, expect, it } from "vitest";
import { parseEscalationRun } from "@/modules/workflow/cron";
import {
  buildCondition,
  cairoLocalToIso,
  canEndDelegation,
  clauseRowsFromForm,
  clausesToRows,
  editorRows,
  errorKeyFor,
  formatClauseValue,
  groupDelegations,
  hoursToMinutes,
  isoToCairoLocal,
  localizedName,
  minutesToHours,
  nextStageNo,
  openEscalations,
  parseCondition,
  workflowLabelKey,
  zoneOffsetMinutes,
} from "@/modules/workflow/logic";
import type { DelegationRow, EscalationRow } from "@/modules/workflow/types";

/** Synthetic view rows (no real data). */
function delegation(overrides: Partial<DelegationRow> = {}): DelegationRow {
  return {
    id: "d0000000-0000-0000-0000-000000000001",
    from_user_id: "00000000-0000-0000-0000-0000000000a3",
    from_name_en: "Area Mgr Test",
    from_name_ar: null,
    to_user_id: "00000000-0000-0000-0000-0000000000a8",
    to_name_en: "Inventory Test",
    to_name_ar: null,
    definition_id: null,
    workflow_code: null,
    workflow_name: null,
    valid_from: "2026-11-01T08:00:00Z",
    valid_to: "2026-11-08T08:00:00Z",
    created_at: "2026-10-30T08:00:00Z",
    created_by: null,
    reason: null,
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null,
    status: "active",
    is_from_me: true,
    is_to_me: false,
    ...overrides,
  };
}

function escalation(overrides: Partial<EscalationRow> = {}): EscalationRow {
  return {
    request_id: "e0000000-0000-0000-0000-000000000001",
    workflow_code: "sales.order.discount",
    workflow_name: "Order discount above limit",
    entity_type: "sales.order",
    entity_id: "e1000000-0000-0000-0000-000000000001",
    status: "pending",
    current_stage: 1,
    stage_no: 1,
    created_at: "2026-10-30T06:00:00Z",
    level: 1,
    first_escalated_at: "2026-10-30T08:00:00Z",
    last_escalated_at: "2026-10-30T08:00:00Z",
    i_am_target: false,
    is_open: true,
    can_decide: false,
    ...overrides,
  };
}

describe("buildCondition", () => {
  it("no filled rows means always ({})", () => {
    expect(buildCondition([])).toEqual({ ok: true, condition: {} });
    expect(buildCondition(editorRows([]))).toEqual({ ok: true, condition: {} });
  });

  it("builds typed clauses in the {all:[...]} format", () => {
    const result = buildCondition([
      { field: "amount", op: ">", type: "number", value: "10000" },
      { field: "order.kind", op: "in", type: "text_list", value: "clinic, lab" },
      { field: "credit_exceeded", op: "=", type: "boolean", value: "true" },
      { field: "zone", op: "in", type: "number_list", value: "1,2, 3" },
      { field: "", op: ">", type: "number", value: "" },
    ]);
    expect(result).toEqual({
      ok: true,
      condition: {
        all: [
          { field: "amount", op: ">", value: 10000 },
          { field: "order.kind", op: "in", value: ["clinic", "lab"] },
          { field: "credit_exceeded", op: "=", value: true },
          { field: "zone", op: "in", value: [1, 2, 3] },
        ],
      },
    });
  });

  it("refuses what the database would refuse", () => {
    expect(buildCondition([{ field: "a; drop table x", op: "=", type: "number", value: "1" }])).toEqual({ ok: false, row: 0, error: "field" });
    expect(buildCondition([{ field: "a", op: "like", type: "text", value: "%" }])).toEqual({ ok: false, row: 0, error: "op" });
    expect(buildCondition([{ field: "a", op: "=", type: "date", value: "x" }])).toEqual({ ok: false, row: 0, error: "type" });
    expect(buildCondition([{ field: "a", op: "in", type: "number", value: "1" }])).toEqual({ ok: false, row: 0, error: "listOp" });
    expect(buildCondition([{ field: "a", op: "=", type: "text_list", value: "x" }])).toEqual({ ok: false, row: 0, error: "listOp" });
    expect(buildCondition([{ field: "a", op: ">", type: "boolean", value: "true" }])).toEqual({ ok: false, row: 0, error: "booleanOp" });
    expect(buildCondition([{ field: "a", op: ">", type: "number", value: "1e5" }])).toEqual({ ok: false, row: 0, error: "value" });
    expect(buildCondition([{ field: "a", op: "=", type: "boolean", value: "yes" }])).toEqual({ ok: false, row: 0, error: "value" });
    expect(buildCondition([{ field: "a", op: "in", type: "number_list", value: "1, x" }])).toEqual({ ok: false, row: 0, error: "value" });
    expect(buildCondition([{ field: "a", op: "=", type: "text", value: "  " }])).toEqual({ ok: false, row: 0, error: "value" });
  });

  it("allows at most 20 clauses", () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ field: `f${i}`, op: "=", type: "number", value: "1" }));
    expect(buildCondition(rows)).toMatchObject({ ok: false, error: "tooMany" });
  });
});

describe("parseCondition / clausesToRows", () => {
  it("round-trips through the editor", () => {
    const stored = { all: [{ field: "amount", op: ">=", value: 2000 }, { field: "kind", op: "in", value: ["a", "b"] }, { field: "x", op: "=", value: false }] };
    const clauses = parseCondition(stored);
    expect(clauses).not.toBeNull();
    const rows = clausesToRows(clauses!);
    expect(rows).toEqual([
      { field: "amount", op: ">=", type: "number", value: "2000" },
      { field: "kind", op: "in", type: "text_list", value: "a, b" },
      { field: "x", op: "=", type: "boolean", value: "false" },
    ]);
    expect(buildCondition(rows!)).toEqual({ ok: true, condition: stored });
  });

  it("{} is an empty clause list; unsupported shapes are null", () => {
    expect(parseCondition({})).toEqual([]);
    expect(parseCondition({ any: [] })).toBeNull();
    expect(parseCondition([1])).toBeNull();
    expect(parseCondition({ all: [{ field: "a", op: "like", value: 1 }] })).toBeNull();
    expect(parseCondition({ all: [{ field: "a", op: "in", value: 1 }] })).toBeNull();
    expect(clausesToRows([{ field: "a", op: "in", value: [true, false] }])).toBeNull();
  });

  it("reads clause rows from a form object and pads editor rows", () => {
    const rows = clauseRowsFromForm({ clause_0_field: "amount", clause_0_op: ">", clause_0_type: "number", clause_0_value: "5", clause_2_value: "x" });
    expect(rows).toEqual([
      { field: "amount", op: ">", type: "number", value: "5" },
      { field: "", op: "", type: "", value: "x" },
    ]);
    expect(editorRows([{ field: "a", op: "=", type: "number", value: "1" }], 3)).toHaveLength(3);
    expect(formatClauseValue([1, 2])).toBe("1, 2");
    expect(formatClauseValue(true)).toBe("true");
  });
});

describe("stages", () => {
  it("converts hours and minutes", () => {
    expect(hoursToMinutes(1.5)).toBe(90);
    expect(hoursToMinutes(0.25)).toBe(15);
    expect(hoursToMinutes(undefined)).toBeNull();
    expect(hoursToMinutes(Number.NaN)).toBeNull();
    expect(minutesToHours(90)).toBe(1.5);
    expect(minutesToHours(20)).toBe(0.33);
    expect(minutesToHours(null)).toBeNull();
  });

  it("next stage number", () => {
    expect(nextStageNo([])).toBe(1);
    expect(nextStageNo([{ stage_no: 1 }, { stage_no: 3 }])).toBe(4);
  });
});

describe("Cairo time for the delegation window", () => {
  it("knows Cairo's winter and summer offsets", () => {
    expect(zoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"))).toBe(120);
    expect(zoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"))).toBe(180);
  });

  it("converts datetime-local values both ways", () => {
    expect(cairoLocalToIso("2026-01-15T09:00")).toBe("2026-01-15T07:00:00.000Z");
    expect(cairoLocalToIso("2026-07-15T09:00")).toBe("2026-07-15T06:00:00.000Z");
    expect(isoToCairoLocal("2026-01-15T07:00:00.000Z")).toBe("2026-01-15T09:00");
    expect(isoToCairoLocal(new Date("2026-07-15T06:00:00.000Z"))).toBe("2026-07-15T09:00");
    expect(cairoLocalToIso("2026-02-30T09:00")).toBeNull();
    expect(cairoLocalToIso("tomorrow")).toBeNull();
  });
});

describe("delegations", () => {
  it("groups mine / to me / team and sorts active first", () => {
    const rows = [
      delegation({ id: "1", status: "ended", valid_from: "2026-10-01T00:00:00Z" }),
      delegation({ id: "2", status: "active" }),
      delegation({ id: "3", is_from_me: false, is_to_me: true }),
      delegation({ id: "4", is_from_me: false, is_to_me: false, status: "scheduled" }),
    ];
    const groups = groupDelegations(rows);
    expect(groups.fromMe.map((r) => r.id)).toEqual(["2", "1"]);
    expect(groups.toMe.map((r) => r.id)).toEqual(["3"]);
    expect(groups.team.map((r) => r.id)).toEqual(["4"]);
  });

  it("offers ending only for open delegations the user is part of or manages", () => {
    expect(canEndDelegation(delegation(), false)).toBe(true);
    expect(canEndDelegation(delegation({ status: "scheduled", is_from_me: false, is_to_me: true }), false)).toBe(true);
    expect(canEndDelegation(delegation({ status: "ended" }), true)).toBe(false);
    expect(canEndDelegation(delegation({ status: "revoked" }), true)).toBe(false);
    expect(canEndDelegation(delegation({ is_from_me: false }), false)).toBe(false);
    expect(canEndDelegation(delegation({ is_from_me: false }), true)).toBe(true);
  });
});

describe("escalations", () => {
  it("lists open escalations, those that reached me first", () => {
    const rows = [
      escalation({ request_id: "a", first_escalated_at: "2026-10-30T07:00:00Z" }),
      escalation({ request_id: "b", i_am_target: true, first_escalated_at: "2026-10-30T09:00:00Z" }),
      escalation({ request_id: "c", is_open: false }),
      escalation({ request_id: "d", can_decide: true, first_escalated_at: "2026-10-30T10:00:00Z" }),
    ];
    expect(openEscalations(rows).map((r) => r.request_id)).toEqual(["b", "d", "a"]);
  });

  it("parses the job result defensively", () => {
    expect(parseEscalationRun({ scanned: 4, escalated: 3, notified: 3, owner_fallback: 1, no_target: 0 })).toEqual({
      scanned: 4,
      escalated: 3,
      notified: 3,
      owner_fallback: 1,
      no_target: 0,
    });
    expect(parseEscalationRun(null)).toEqual({ scanned: 0, escalated: 0, notified: 0, owner_fallback: 0, no_target: 0 });
    expect(parseEscalationRun({ scanned: -1, escalated: "3", notified: 1.5 })).toMatchObject({ scanned: 0, escalated: 0, notified: 0 });
  });
});

describe("labels and errors", () => {
  it("maps database codes to workflow error keys", () => {
    expect(errorKeyFor({ code: "CATCH_ALL_REQUIRED" })).toBe("CATCH_ALL_REQUIRED");
    expect(errorKeyFor({ code: "ESCALATION_BLOCKED" })).toBe("ESCALATION_BLOCKED");
    expect(errorKeyFor({ code: "LIMIT_EXCEEDED" })).toBe("PERMISSION_DENIED");
    expect(errorKeyFor({ code: "SOMETHING_NEW" })).toBe("UNKNOWN");
  });

  it("labels seeded workflows and localizes names", () => {
    expect(workflowLabelKey("finance.credit_note")).toBe("creditNote");
    expect(workflowLabelKey("test.unknown")).toBeNull();
    expect(workflowLabelKey(null)).toBeNull();
    expect(localizedName("ar", "Test Person", null)).toBe("Test Person");
    expect(localizedName("ar", "Test Person", "شخص تجريبي")).toBe("شخص تجريبي");
    expect(localizedName("en", null, null)).toBe("—");
  });
});
