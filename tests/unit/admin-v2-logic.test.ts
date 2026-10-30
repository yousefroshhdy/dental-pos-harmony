import { describe, expect, it } from "vitest";
import { ANONYMOUS_CONTEXT, type UserContext } from "@/lib/authz/can";
import {
  adminErrorCode,
  asStringList,
  asTimeRange,
  buildTerritoryTree,
  canChangeOwnScope,
  canDeactivate,
  canReactivate,
  descendantsOf,
  employmentTone,
  flattenTree,
  groupSettings,
  isDeactivation,
  managerOptions,
  matchesEmployeeFilter,
  moveTargets,
  parentOptions,
  parseEmployeeFilter,
  settingEditState,
  settingUnitKey,
  settingValueText,
  statusTargets,
  subtreeIds,
  toNumber,
  unassignedCustomers,
} from "@/modules/admin/logic";
import { adminNav } from "@/modules/admin/nav";
import type { AdminEmployeeRow, SettingRow, TerritoryRow } from "@/modules/admin/types";
import ar from "../../messages/ar.json";
import en from "../../messages/en.json";

const ME = "11111111-1111-4111-8111-111111111111";

/** Value at a dotted message path, or undefined. */
function lookup(tree: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((n, k) => (typeof n === "object" && n !== null ? (n as Record<string, unknown>)[k] : undefined), tree);
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing test fixture node");
  return value;
}

function ctx(permissions: Record<string, "own" | "team" | "all">, extra: Partial<UserContext> = {}): UserContext {
  return {
    ...ANONYMOUS_CONTEXT,
    user_id: ME,
    active: true,
    status: "active",
    employee: { id: "e-me", employee_no: "E900", full_name_en: "Test Admin", full_name_ar: null, job_title: "Admin" },
    permissions: Object.fromEntries(Object.entries(permissions).map(([p, scope]) => [p, { scope, limit: null }])),
    ...extra,
  };
}

const admin = ctx({ "admin.settings.manage": "all", "core.employee.manage": "all", "core.territory.manage": "all" });
const owner = ctx({}, { is_owner: true });

function setting(over: Partial<SettingRow>): SettingRow {
  return {
    key: "field.geofence_radius_m",
    group_code: "field",
    value_type: "integer",
    min_value: 25,
    max_value: 2000,
    allowed_values: null,
    default_value: 150,
    unit: "m",
    owner_only: false,
    is_editable: true,
    is_whitelisted: true,
    label_en: "Check-in radius",
    label_ar: "نطاق تسجيل الوصول",
    description_en: "d",
    description_ar: "د",
    value: 150,
    is_default: true,
    updated_at: null,
    updated_by: null,
    sort_order: 10,
    ...over,
  };
}

describe("admin error codes", () => {
  it("recognises admin business codes only", () => {
    expect(adminErrorCode("MANAGER_CYCLE")).toBe("MANAGER_CYCLE");
    expect(adminErrorCode("SETTING_OUT_OF_RANGE")).toBe("SETTING_OUT_OF_RANGE");
    expect(adminErrorCode("PERMISSION_DENIED")).toBeUndefined();
    expect(adminErrorCode("")).toBeUndefined();
  });

  it("has a translation for every code in both languages", () => {
    for (const code of ["MANAGER_CYCLE", "TERRITORY_CYCLE", "TERRITORY_TOO_DEEP", "TERRITORY_HAS_CHILDREN", "SETTING_NOT_WHITELISTED", "SETTING_READ_ONLY", "SETTING_OUT_OF_RANGE", "SETTING_SECRET_REFUSED"]) {
      expect(lookup(en, `admin.errors.${code}`)).toEqual(expect.any(String));
      expect(lookup(ar, `admin.errors.${code}`)).toEqual(expect.any(String));
    }
  });
});

describe("admin nav", () => {
  it("every label resolves in both languages", () => {
    for (const item of adminNav) {
      expect(item.labelKey.startsWith("admin.")).toBe(true);
      expect(lookup(en, item.labelKey)).toEqual(expect.any(String));
      expect(lookup(ar, item.labelKey)).toEqual(expect.any(String));
    }
  });

  it("gates every admin screen by a permission", () => {
    expect(adminNav.every((i) => i.permission !== null)).toBe(true);
    expect(adminNav.map((i) => i.href)).toContain("/admin/settings");
  });
});

describe("settings", () => {
  it("groups in a fixed order, unknown groups last, items by sort order", () => {
    const groups = groupSettings([
      setting({ key: "zzz.thing", group_code: "zzz", sort_order: 1 }),
      setting({ key: "tracking.b", group_code: "tracking", sort_order: 20 }),
      setting({ key: "tracking.a", group_code: "tracking", sort_order: 10 }),
      setting({ key: "company.name", group_code: "company", sort_order: 10 }),
    ]);
    expect(groups.map((g) => g.group)).toEqual(["company", "tracking", "zzz"]);
    expect(groups[1]?.items.map((i) => i.key)).toEqual(["tracking.a", "tracking.b"]);
    expect(groups[2]?.labelKey).toBe("other");
  });

  it("owner-only settings are editable by owners only", () => {
    const row = setting({ owner_only: true });
    expect(settingEditState(admin, row)).toBe("ownerOnly");
    expect(settingEditState(owner, row)).toBe("editable");
    expect(settingEditState(admin, setting({}))).toBe("editable");
  });

  it("fixed and unknown keys are never editable, not even by an owner", () => {
    expect(settingEditState(owner, setting({ is_editable: false }))).toBe("fixed");
    expect(settingEditState(owner, setting({ is_whitelisted: false, is_editable: false }))).toBe("notWhitelisted");
  });

  it("without admin.settings.manage nothing is editable", () => {
    expect(settingEditState(ctx({}), setting({}))).not.toBe("editable");
  });

  it("maps units and values for display", () => {
    expect(settingUnitKey("km/h")).toBe("kmh");
    expect(settingUnitKey("%")).toBe("percent");
    expect(settingUnitKey("furlongs")).toBeNull();
    expect(settingUnitKey(null)).toBeNull();
    expect(toNumber("14.50")).toBe(14.5);
    expect(toNumber("abc")).toBeNull();
    expect(settingValueText(null)).toBe("—");
    expect(settingValueText(true)).toBe("true");
    expect(asTimeRange({ start: "09:00", end: "17:00" })).toEqual({ start: "09:00", end: "17:00" });
    expect(asTimeRange("09:00")).toBeNull();
    expect(asStringList(["sun", 3, "mon"])).toEqual(["sun", "mon"]);
  });
});

function emp(id: string, manager: string | null, status: AdminEmployeeRow["employment_status"] = "active") {
  return { id, manager_id: manager, employment_status: status, employee_no: id.toUpperCase() };
}

describe("employees", () => {
  // e1 → e2 → e3 → e4 (and e5 under e2, terminated e6)
  const rows = [emp("e1", null), emp("e2", "e1"), emp("e3", "e2"), emp("e4", "e3"), emp("e5", "e2", "on_leave"), emp("e6", "e1", "terminated")];

  it("finds everyone below an employee, however deep", () => {
    expect([...descendantsOf(rows, "e2")].sort()).toEqual(["e3", "e4", "e5"]);
    expect(descendantsOf(rows, "e4").size).toBe(0);
  });

  it("survives a corrupt cycle", () => {
    expect([...descendantsOf([emp("a", "b"), emp("b", "a")], "a")]).toEqual(["b"]);
  });

  it("never offers a manager that would close a loop", () => {
    const ids = managerOptions(rows, "e2").map((r) => r.id);
    expect(ids).toEqual(["e1"]);
    expect(managerOptions(rows, null).map((r) => r.id)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });

  it("does not offer terminated managers", () => {
    expect(managerOptions(rows, "e4").map((r) => r.id)).not.toContain("e6");
  });

  it("offers status changes to others, never to yourself", () => {
    expect(statusTargets(admin, { id: "e2", employment_status: "active" })).toEqual(["on_leave", "suspended", "terminated"]);
    expect(statusTargets(admin, { id: "e-me", employment_status: "active" })).toEqual([]);
    expect(statusTargets(ctx({ "core.employee.read": "all" }), { id: "e2", employment_status: "active" })).toEqual([]);
  });

  it("locks your own scope fields unless you are an owner", () => {
    expect(canChangeOwnScope(admin, "e-me")).toBe(false);
    expect(canChangeOwnScope(admin, "e2")).toBe(true);
    expect(canChangeOwnScope({ ...owner, employee: admin.employee }, "e-me")).toBe(true);
  });

  it("classifies statuses", () => {
    expect(isDeactivation("terminated")).toBe(true);
    expect(isDeactivation("on_leave")).toBe(false);
    expect(employmentTone("suspended")).toBe("warning");
    expect(parseEmployeeFilter("inactive")).toBe("inactive");
    expect(parseEmployeeFilter(["all"])).toBe("all");
    expect(parseEmployeeFilter("bogus")).toBe("current");
    expect(matchesEmployeeFilter("on_leave", "current")).toBe(true);
    expect(matchesEmployeeFilter("terminated", "current")).toBe(false);
    expect(matchesEmployeeFilter("suspended", "inactive")).toBe(true);
  });
});

function terr(id: string, parent: string | null, active = true): TerritoryRow {
  return { id, code: id.toUpperCase(), name_en: id, name_ar: id, parent_id: parent, level: null, is_active: active };
}

describe("territories", () => {
  // r1 → a1 → s1 ; r1 → a2 ; r2 (no children)
  const rows = [terr("s1", "a1"), terr("a2", "r1"), terr("r2", null), terr("a1", "r1"), terr("r1", null)];
  const counts = [
    { territory_id: "s1", customers: 2, active_customers: 1, leads: 1, employees: 1 },
    { territory_id: "a1", customers: 3, active_customers: 3, leads: 0, employees: 2 },
    { territory_id: "r1", customers: 1, active_customers: 0, leads: 1, employees: 0 },
    { territory_id: null, customers: 7, active_customers: 4, leads: 3, employees: 0 },
  ];
  const roots = buildTerritoryTree(rows, counts);
  const flat = flattenTree(roots);
  const node = (id: string) => must(flat.find((n) => n.territory.id === id));

  it("builds a sorted tree with depth and height", () => {
    expect(flat.map((n) => `${n.territory.id}@${n.depth}`)).toEqual(["r1@0", "a1@1", "s1@2", "a2@1", "r2@0"]);
    expect(node("r1").height).toBe(2);
    expect(node("a1").height).toBe(1);
    expect(node("s1").height).toBe(0);
  });

  it("rolls customer counts up the tree", () => {
    expect(node("r1").totalCustomers).toBe(6);
    expect(node("a1").totalCustomers).toBe(5);
    expect(node("r2").totalCustomers).toBe(0);
    expect(node("a1").employees).toBe(2);
    expect(unassignedCustomers(counts)).toBe(7);
    expect(unassignedCustomers(counts.slice(0, 3))).toBeNull();
  });

  it("treats a node whose parent is missing as a root", () => {
    expect(buildTerritoryTree([terr("x", "missing")]).map((n) => n.territory.id)).toEqual(["x"]);
  });

  it("never offers a move under itself or a descendant", () => {
    const targets = moveTargets(flat, node("r1")).map((n) => n.territory.id);
    expect(targets).not.toContain("a1");
    expect(targets).not.toContain("s1");
    expect(targets).not.toContain("r1");
    expect([...subtreeIds(node("r1"))].sort()).toEqual(["a1", "a2", "r1", "s1"]);
    expect([...subtreeIds(node("a1"))].sort()).toEqual(["a1", "s1"]);
  });

  it("respects the three-level limit", () => {
    // r1 has height 2, so it cannot go under anything.
    expect(moveTargets(flat, node("r1"))).toEqual([]);
    // a1 (height 1) can go under a region, not under an area.
    expect(moveTargets(flat, node("a1")).map((n) => n.territory.id)).toEqual(["r2"]);
    // s1 (a leaf) can go under any region or area except its current parent.
    expect(moveTargets(flat, node("s1")).map((n) => n.territory.id)).toEqual(["r1", "a2", "r2"]);
    expect(parentOptions(flat).map((n) => n.territory.id)).toEqual(["r1", "a1", "a2", "r2"]);
  });

  it("skips inactive parents", () => {
    const tree = flattenTree(buildTerritoryTree([terr("r1", null), terr("r2", null, false), terr("a1", "r1")]));
    const a1 = must(tree.find((n) => n.territory.id === "a1"));
    expect(moveTargets(tree, a1).map((n) => n.territory.id)).toEqual([]);
    expect(parentOptions(tree).map((n) => n.territory.id)).toEqual(["r1", "a1"]);
  });

  it("deactivation needs inactive children; reactivation an active parent", () => {
    expect(canDeactivate(node("r1"))).toBe(false);
    expect(canDeactivate(node("s1"))).toBe(true);
    const tree = flattenTree(buildTerritoryTree([terr("r1", null, false), terr("a1", "r1", false)]));
    const r1 = must(tree[0]);
    const a1 = must(tree[1]);
    expect(canDeactivate(r1)).toBe(false);
    expect(canReactivate(a1, r1)).toBe(false);
    expect(canReactivate(r1, undefined)).toBe(true);
  });
});
