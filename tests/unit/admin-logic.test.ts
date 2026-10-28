import { describe, expect, it } from "vitest";
import { ANONYMOUS_CONTEXT, type UserContext } from "@/lib/authz/can";
import {
  activeRolesByUser,
  allowedScopesOf,
  canEditRole,
  canGrantTo,
  canInvite,
  canRevokeAssignment,
  defaultScopeFor,
  grantableRoles,
  groupPermissionsByModule,
  isActiveAssignment,
  localizedName,
  severityTone,
  statusTone,
  toLimit,
  userRowActions,
} from "@/modules/admin/logic";
import type { PermissionRow, RoleRow, UserRoleRow } from "@/modules/admin/types";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function ctx(permissions: Record<string, "own" | "team" | "all">, extra: Partial<UserContext> = {}): UserContext {
  return {
    ...ANONYMOUS_CONTEXT,
    user_id: ME,
    active: true,
    status: "active",
    permissions: Object.fromEntries(Object.entries(permissions).map(([k, scope]) => [k, { scope, limit: null }])),
    ...extra,
  };
}

const role = (over: Partial<RoleRow>): RoleRow => ({
  id: "r",
  code: "role",
  name_en: "Role",
  name_ar: null,
  description: null,
  is_system: false,
  is_owner_role: false,
  is_active: true,
  permission_count: 0,
  ...over,
});

const assignment = (over: Partial<UserRoleRow>): UserRoleRow => ({
  id: "a",
  user_id: OTHER,
  role_id: "r",
  role_code: "role",
  role_name_en: "Role",
  scope_territory_id: null,
  scope_warehouse_id: null,
  valid_from: "2026-01-01T00:00:00Z",
  valid_to: null,
  granted_at: "2026-01-01T00:00:00Z",
  revoked_at: null,
  ...over,
});

const perm = (code: string, over: Partial<PermissionRow> = {}): PermissionRow => ({
  code,
  module: code.split(".")[0] ?? "",
  description: code,
  allowed_scopes: ["own", "team", "territory", "department", "warehouse", "all"],
  supports_limit: false,
  is_sensitive: false,
  ...over,
});

describe("localizedName", () => {
  it("prefers Arabic in the Arabic UI and falls back to English", () => {
    expect(localizedName("ar", "Mona", "منى")).toBe("منى");
    expect(localizedName("ar", "Mona", null)).toBe("Mona");
    expect(localizedName("en", "Mona", "منى")).toBe("Mona");
    expect(localizedName("en", null, null)).toBe("");
  });
});

describe("badge tones", () => {
  it("maps status and severity", () => {
    expect(statusTone("active")).toBe("success");
    expect(statusTone("suspended")).toBe("warning");
    expect(statusTone("disabled")).toBe("danger");
    expect(severityTone("critical")).toBe("danger");
    expect(severityTone("warning")).toBe("warning");
    expect(severityTone("info")).toBe("info");
  });
});

describe("isActiveAssignment / activeRolesByUser", () => {
  const now = new Date("2026-10-28T12:00:00Z");

  it("excludes revoked, future and expired assignments", () => {
    expect(isActiveAssignment(assignment({}), now)).toBe(true);
    expect(isActiveAssignment(assignment({ revoked_at: "2026-05-01T00:00:00Z" }), now)).toBe(false);
    expect(isActiveAssignment(assignment({ valid_from: "2026-11-01T00:00:00Z" }), now)).toBe(false);
    expect(isActiveAssignment(assignment({ valid_to: "2026-10-01T00:00:00Z" }), now)).toBe(false);
    expect(isActiveAssignment(assignment({ valid_to: "2026-12-01T00:00:00Z" }), now)).toBe(true);
  });

  it("groups by user, uses role names from v_roles and sorts by code", () => {
    const roles = [role({ id: "r1", code: "sales_rep", name_ar: "مندوب" }), role({ id: "r2", code: "owner", is_owner_role: true })];
    const map = activeRolesByUser(
      [
        assignment({ id: "a1", role_id: "r1", role_code: "sales_rep" }),
        assignment({ id: "a2", role_id: "r2", role_code: "owner" }),
        assignment({ id: "a3", role_id: "r1", role_code: "sales_rep", revoked_at: "2026-02-01T00:00:00Z" }),
        assignment({ id: "a4", user_id: ME, role_id: "r1", role_code: "sales_rep" }),
      ],
      roles,
      now,
    );
    expect(map.get(OTHER)?.map((r) => r.code)).toEqual(["owner", "sales_rep"]);
    expect(map.get(OTHER)?.[0]?.isOwnerRole).toBe(true);
    expect(map.get(OTHER)?.[1]?.nameAr).toBe("مندوب");
    expect(map.get(ME)).toHaveLength(1);
  });
});

describe("userRowActions", () => {
  it("offers suspend for other active users only, reactivate for suspended ones", () => {
    const admin = ctx({ "admin.user.suspend": "all", "admin.role.read": "all" });
    expect(userRowActions(admin, { user_id: OTHER, status: "active" })).toEqual({ suspend: true, reactivate: false, manageRoles: true });
    expect(userRowActions(admin, { user_id: OTHER, status: "suspended" })).toEqual({ suspend: false, reactivate: true, manageRoles: true });
    expect(userRowActions(admin, { user_id: ME, status: "active" }).suspend).toBe(false);
    expect(userRowActions(admin, { user_id: OTHER, status: "disabled" })).toMatchObject({ suspend: false, reactivate: false });
  });

  it("offers nothing without the permissions", () => {
    const reader = ctx({ "admin.user.read": "all" });
    expect(userRowActions(reader, { user_id: OTHER, status: "active" })).toEqual({ suspend: false, reactivate: false, manageRoles: false });
  });

  it("offers nothing to an inactive context even if it lists permissions", () => {
    const inactive = ctx({ "admin.user.suspend": "all" }, { active: false });
    expect(userRowActions(inactive, { user_id: OTHER, status: "active" }).suspend).toBe(false);
  });
});

describe("canInvite", () => {
  it("needs both admin.user.create and core.employee.manage", () => {
    expect(canInvite(ctx({ "admin.user.create": "all" }))).toBe(false);
    expect(canInvite(ctx({ "core.employee.manage": "all" }))).toBe(false);
    expect(canInvite(ctx({ "admin.user.create": "all", "core.employee.manage": "all" }))).toBe(true);
    expect(canInvite(ctx({}, { is_owner: true }))).toBe(true);
  });
});

describe("role gating", () => {
  const manager = ctx({ "admin.role.manage": "all", "admin.role.assign": "all" });
  const owner = ctx({}, { is_owner: true });

  it("never offers editing the owner role", () => {
    expect(canEditRole(manager, { is_owner_role: false })).toBe(true);
    expect(canEditRole(manager, { is_owner_role: true })).toBe(false);
    expect(canEditRole(owner, { is_owner_role: true })).toBe(false);
    expect(canEditRole(ctx({ "admin.role.read": "all" }), { is_owner_role: false })).toBe(false);
  });

  it("offers the owner role for granting and revoking only to owners", () => {
    const roles = [role({ id: "b", code: "sales_rep" }), role({ id: "o", code: "owner", is_owner_role: true }), role({ id: "x", code: "old", is_active: false })];
    expect(grantableRoles(roles, manager).map((r) => r.code)).toEqual(["sales_rep"]);
    expect(grantableRoles(roles, owner).map((r) => r.code)).toEqual(["owner", "sales_rep"]);
    expect(canRevokeAssignment(manager, { isOwnerRole: true })).toBe(false);
    expect(canRevokeAssignment(manager, { isOwnerRole: false })).toBe(true);
    expect(canRevokeAssignment(owner, { isOwnerRole: true })).toBe(true);
  });

  it("does not offer self-grants except to owners", () => {
    expect(canGrantTo(manager, OTHER)).toBe(true);
    expect(canGrantTo(manager, ME)).toBe(false);
    expect(canGrantTo(owner, ME)).toBe(true);
    expect(canGrantTo(ctx({ "admin.role.read": "all" }), OTHER)).toBe(false);
  });
});

describe("permission matrix", () => {
  it("orders allowed scopes canonically and drops unknown ones", () => {
    expect(allowedScopesOf({ allowed_scopes: ["all", "own", "bogus", "team"] })).toEqual(["own", "team", "all"]);
  });

  it("parses numeric limits from PostgREST", () => {
    expect(toLimit("5.00")).toBe(5);
    expect(toLimit(250000)).toBe(250000);
    expect(toLimit(null)).toBeNull();
    expect(toLimit("x")).toBeNull();
  });

  it("groups by module, joins the role's grants and counts them", () => {
    const groups = groupPermissionsByModule(
      [
        perm("sales.order.read"),
        perm("admin.user.read"),
        perm("sales.discount.apply", { supports_limit: true, allowed_scopes: ["own", "team"] }),
      ],
      [
        { role_id: "r", permission_code: "sales.discount.apply", scope: "team", limit_value: "3.00" },
        { role_id: "r", permission_code: "admin.user.read", scope: "all", limit_value: null },
      ],
    );
    expect(groups.map((g) => g.module)).toEqual(["admin", "sales"]);
    const sales = groups[1];
    expect(sales?.items.map((i) => i.code)).toEqual(["sales.discount.apply", "sales.order.read"]);
    expect(sales?.grantedCount).toBe(1);
    expect(sales?.items[0]?.grant).toEqual({ scope: "team", limit: 3 });
    expect(sales?.items[0]?.scopes).toEqual(["own", "team"]);
    expect(sales?.items[1]?.grant).toBeNull();
    expect(groups[0]?.items[0]?.grant).toEqual({ scope: "all", limit: null });
  });

  it("defaults the edit form to the current scope, else the narrowest allowed", () => {
    expect(defaultScopeFor({ grant: { scope: "team", limit: null }, scopes: ["own", "team", "all"] })).toBe("team");
    expect(defaultScopeFor({ grant: null, scopes: ["territory", "all"] })).toBe("territory");
  });
});
