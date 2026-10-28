import { can, SCOPES, type Scope, type UserContext } from "@/lib/authz/can";
import type { PermissionRow, ProfileStatus, RolePermissionRow, RoleRow, Severity, UserRoleRow, UserRow } from "./types";

/**
 * Pure presentation logic for the admin console. UI gating here is cosmetic:
 * Postgres re-checks every action (docs/AUTHORIZATION.md §5).
 */

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

/** Name in the viewer's locale, falling back to English. */
export function localizedName(locale: string, en: string | null | undefined, ar: string | null | undefined): string {
  if (locale === "ar" && ar) return ar;
  return en ?? ar ?? "";
}

export function statusTone(status: ProfileStatus): BadgeTone {
  return status === "active" ? "success" : status === "suspended" ? "warning" : "danger";
}

export function severityTone(severity: Severity): BadgeTone {
  return severity === "critical" ? "danger" : severity === "warning" ? "warning" : "info";
}

/** An assignment is in force: not revoked and inside its validity window. */
export function isActiveAssignment(a: Pick<UserRoleRow, "revoked_at" | "valid_from" | "valid_to">, now: Date): boolean {
  if (a.revoked_at) return false;
  if (new Date(a.valid_from) > now) return false;
  return a.valid_to === null || new Date(a.valid_to) > now;
}

export interface AssignedRole {
  assignmentId: string;
  roleId: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  isOwnerRole: boolean;
}

/** Active role assignments grouped by user id, with role names from api.v_roles. */
export function activeRolesByUser(assignments: UserRoleRow[], roles: RoleRow[], now: Date): Map<string, AssignedRole[]> {
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const out = new Map<string, AssignedRole[]>();
  for (const a of assignments) {
    if (!isActiveAssignment(a, now)) continue;
    const role = roleById.get(a.role_id);
    const list = out.get(a.user_id) ?? [];
    list.push({
      assignmentId: a.id,
      roleId: a.role_id,
      code: a.role_code,
      nameEn: role?.name_en ?? a.role_name_en,
      nameAr: role?.name_ar ?? null,
      isOwnerRole: role?.is_owner_role ?? false,
    });
    out.set(a.user_id, list);
  }
  for (const list of out.values()) list.sort((x, y) => x.code.localeCompare(y.code));
  return out;
}

export interface UserRowActions {
  suspend: boolean;
  reactivate: boolean;
  manageRoles: boolean;
}

/** Which row actions to offer on the users table. */
export function userRowActions(ctx: UserContext, row: Pick<UserRow, "user_id" | "status">): UserRowActions {
  const mayToggle = can(ctx, "admin.user.suspend");
  return {
    // Self-suspension is refused by the DB (SELF_SUSPEND_FORBIDDEN); don't offer it.
    suspend: mayToggle && row.status === "active" && row.user_id !== ctx.user_id,
    reactivate: mayToggle && row.status === "suspended",
    manageRoles: can(ctx, "admin.role.read"),
  };
}

/** Invite needs both permissions (api.create_employee + api.register_user). */
export function canInvite(ctx: UserContext): boolean {
  return can(ctx, "admin.user.create") && can(ctx, "core.employee.manage");
}

/** Roles that may be offered in the grant form. The owner role only for owners (the DB enforces OWNER_ONLY). */
export function grantableRoles(roles: RoleRow[], ctx: UserContext): RoleRow[] {
  return roles
    .filter((r) => r.is_active && (!r.is_owner_role || ctx.is_owner))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** The owner role is implicit-all and never editable; others need admin.role.manage. */
export function canEditRole(ctx: UserContext, role: Pick<RoleRow, "is_owner_role">): boolean {
  return !role.is_owner_role && can(ctx, "admin.role.manage");
}

/** Non-owners can't grant themselves roles (SELF_GRANT_FORBIDDEN in api.grant_role). */
export function canGrantTo(ctx: UserContext, targetUserId: string): boolean {
  return can(ctx, "admin.role.assign") && (targetUserId !== ctx.user_id || ctx.is_owner);
}

export function canRevokeAssignment(ctx: UserContext, assignment: Pick<AssignedRole, "isOwnerRole">): boolean {
  return can(ctx, "admin.role.assign") && (!assignment.isOwnerRole || ctx.is_owner);
}

/** Allowed scopes of a permission, in canonical (narrow → wide) order, unknown values dropped. */
export function allowedScopesOf(permission: Pick<PermissionRow, "allowed_scopes">): Scope[] {
  const allowed = new Set(permission.allowed_scopes);
  return SCOPES.filter((s) => allowed.has(s));
}

/** numeric(14,2) from PostgREST → number | null. */
export function toLimit(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface PermissionMatrixItem extends PermissionRow {
  scopes: Scope[];
  grant: { scope: Scope; limit: number | null } | null;
}

export interface PermissionModuleGroup {
  module: string;
  items: PermissionMatrixItem[];
  grantedCount: number;
}

/** Permission catalogue joined with one role's grants, grouped by module (modules and codes sorted). */
export function groupPermissionsByModule(permissions: PermissionRow[], rolePermissions: RolePermissionRow[]): PermissionModuleGroup[] {
  const grants = new Map(rolePermissions.map((rp) => [rp.permission_code, rp]));
  const groups = new Map<string, PermissionMatrixItem[]>();
  for (const p of permissions) {
    const rp = grants.get(p.code);
    const scope = rp && (SCOPES as readonly string[]).includes(rp.scope) ? (rp.scope as Scope) : null;
    const item: PermissionMatrixItem = {
      ...p,
      scopes: allowedScopesOf(p),
      grant: rp && scope ? { scope, limit: toLimit(rp.limit_value) } : null,
    };
    const list = groups.get(p.module) ?? [];
    list.push(item);
    groups.set(p.module, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, items]) => {
      items.sort((x, y) => x.code.localeCompare(y.code));
      return { module, items, grantedCount: items.filter((i) => i.grant !== null).length };
    });
}

/** Default scope for the edit form: the current grant, else the narrowest allowed. */
export function defaultScopeFor(item: Pick<PermissionMatrixItem, "grant" | "scopes">): Scope {
  return item.grant?.scope ?? item.scopes[0] ?? "own";
}
