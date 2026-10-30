import { can, SCOPES, type Scope, type UserContext } from "@/lib/authz/can";
import type { AppError } from "@/lib/errors";
import type {
  ActionResult,
  AdminEmployeeRow,
  AdminErrorCode,
  EmploymentStatus,
  PermissionRow,
  ProfileStatus,
  RolePermissionRow,
  RoleRow,
  SettingRow,
  Severity,
  TerritoryCountRow,
  TerritoryRow,
  UserRoleRow,
  UserRow,
} from "./types";

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

// ---------------------------------------------------------------------------
// Admin console v2: error codes
// ---------------------------------------------------------------------------

export const ADMIN_ERROR_CODES = [
  "MANAGER_CYCLE",
  "TERRITORY_CYCLE",
  "TERRITORY_TOO_DEEP",
  "TERRITORY_HAS_CHILDREN",
  "SETTING_NOT_WHITELISTED",
  "SETTING_READ_ONLY",
  "SETTING_OUT_OF_RANGE",
  "SETTING_SECRET_REFUSED",
] as const satisfies readonly AdminErrorCode[];

/** The admin.errors.* key for a business code, if the admin module translates it. */
export function adminErrorCode(code: string): AdminErrorCode | undefined {
  return (ADMIN_ERROR_CODES as readonly string[]).includes(code) ? (code as AdminErrorCode) : undefined;
}

/** The browser-safe result of a failed admin command: a translatable key, never the raw message. */
export function failedResult(error: Pick<AppError, "code" | "messageKey" | "requestId">): ActionResult {
  const adminCode = adminErrorCode(error.code);
  return { ok: false, messageKey: error.messageKey, requestId: error.requestId, ...(adminCode ? { adminCode } : {}) };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Display order of setting groups; unknown groups follow, alphabetically. */
export const SETTING_GROUP_ORDER = ["company", "sales", "field", "offline", "commission", "finance", "tracking", "security"] as const;

export interface SettingGroup {
  group: string;
  /** Key under admin.settings.groups ("other" for a group the UI does not know yet). */
  labelKey: string;
  items: SettingRow[];
}

export function groupSettings(rows: SettingRow[]): SettingGroup[] {
  const known = SETTING_GROUP_ORDER as readonly string[];
  const groups = new Map<string, SettingRow[]>();
  for (const row of rows) {
    const list = groups.get(row.group_code) ?? [];
    list.push(row);
    groups.set(row.group_code, list);
  }
  const rank = (g: string) => (known.includes(g) ? known.indexOf(g) : known.length);
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([group, items]) => ({
      group,
      labelKey: known.includes(group) ? group : "other",
      items: [...items].sort((x, y) => x.sort_order - y.sort_order || x.key.localeCompare(y.key)),
    }));
}

export type SettingEditState = "editable" | "ownerOnly" | "fixed" | "notWhitelisted";

/** Whether the viewer may edit a setting (UX only; api.update_setting re-checks). */
export function settingEditState(
  ctx: UserContext,
  row: Pick<SettingRow, "is_whitelisted" | "is_editable" | "owner_only">,
): SettingEditState {
  if (!row.is_whitelisted) return "notWhitelisted";
  if (!row.is_editable) return "fixed";
  if (row.owner_only && !ctx.is_owner) return "ownerOnly";
  return can(ctx, "admin.settings.manage") ? "editable" : "ownerOnly";
}

/** Unit code from core.setting_definitions → key under admin.settings.units. */
const UNIT_KEYS: Record<string, string> = {
  m: "meters",
  s: "seconds",
  min: "minutes",
  h: "hours",
  days: "days",
  "%": "percent",
  "km/h": "kmh",
  points: "points",
};

export function settingUnitKey(unit: string | null | undefined): string | null {
  return unit ? (UNIT_KEYS[unit] ?? null) : null;
}

/** numeric from PostgREST → number | null. */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export const WEEKDAYS = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"] as const;

/** A scalar setting value as text; lists and ranges are formatted by the caller. */
export function settingValueText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** {start, end} of a time-range setting, or null. */
export function asTimeRange(value: unknown): { start: string; end: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  return typeof v.start === "string" && typeof v.end === "string" ? { start: v.start, end: v.end } : null;
}

export function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export const EMPLOYMENT_STATUSES = ["active", "on_leave", "suspended", "terminated"] as const satisfies readonly EmploymentStatus[];

export function employmentTone(status: EmploymentStatus): BadgeTone {
  return status === "active" ? "success" : status === "on_leave" ? "info" : status === "suspended" ? "warning" : "danger";
}

/** Suspended and terminated employees have no access at all (authz.is_active_user). */
export function isDeactivation(status: EmploymentStatus): boolean {
  return status === "suspended" || status === "terminated";
}

/** Everyone below `employeeId` in the manager chain (cycle-safe). */
export function descendantsOf(rows: Pick<AdminEmployeeRow, "id" | "manager_id">[], employeeId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.manager_id) continue;
    const list = children.get(r.manager_id) ?? [];
    list.push(r.id);
    children.set(r.manager_id, list);
  }
  const out = new Set<string>();
  const stack = [...(children.get(employeeId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (out.has(id) || id === employeeId) continue;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

/**
 * Managers to offer for an employee: active or on leave, neither the employee nor anyone who
 * (indirectly) reports to them, which would close a loop (the DB raises MANAGER_CYCLE).
 * `employeeId` null = a new employee.
 */
export function managerOptions<T extends Pick<AdminEmployeeRow, "id" | "manager_id" | "employment_status" | "employee_no">>(
  rows: T[],
  employeeId: string | null,
): T[] {
  const below = employeeId ? descendantsOf(rows, employeeId) : new Set<string>();
  return rows
    .filter((r) => r.id !== employeeId && !below.has(r.id) && (r.employment_status === "active" || r.employment_status === "on_leave"))
    .sort((a, b) => a.employee_no.localeCompare(b.employee_no));
}

/** Statuses an employee may be moved to; none for yourself (SELF_SUSPEND_FORBIDDEN). */
export function statusTargets(ctx: UserContext, employee: Pick<AdminEmployeeRow, "id" | "employment_status">): EmploymentStatus[] {
  if (!can(ctx, "core.employee.manage") || ctx.employee?.id === employee.id) return [];
  return EMPLOYMENT_STATUSES.filter((s) => s !== employee.employment_status);
}

/** Manager, department and territories drive the holder's own scope: no self-service unless owner. */
export function canChangeOwnScope(ctx: UserContext, employeeId: string): boolean {
  return ctx.is_owner || ctx.employee?.id !== employeeId;
}

/** Filter for the employees list (?status=). */
export type EmployeeFilter = "current" | "inactive" | "all";

export function parseEmployeeFilter(raw: string | string[] | undefined): EmployeeFilter {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "inactive" || v === "all" ? v : "current";
}

export function matchesEmployeeFilter(status: EmploymentStatus, filter: EmployeeFilter): boolean {
  if (filter === "all") return true;
  return filter === "inactive" ? isDeactivation(status) : !isDeactivation(status);
}

// ---------------------------------------------------------------------------
// Territories
// ---------------------------------------------------------------------------

/** Deepest allowed depth (region 0 → area 1 → sub_area 2), as in api.create_territory. */
export const MAX_TERRITORY_DEPTH = 2;

export interface TerritoryNode {
  territory: TerritoryRow;
  depth: number;
  children: TerritoryNode[];
  /** Customers directly in this territory. */
  customers: number;
  activeCustomers: number;
  leads: number;
  employees: number;
  /** Customers in this territory and every sub-territory. */
  totalCustomers: number;
  /** Levels below this node (a leaf is 0). */
  height: number;
}

const byCode = (a: TerritoryNode, b: TerritoryNode) => a.territory.code.localeCompare(b.territory.code);

/**
 * The territory tree, children sorted by code, counts rolled up. A node whose parent is not in
 * `territories` becomes a root. The DB forbids cycles; any found here are cut defensively.
 */
export function buildTerritoryTree(territories: TerritoryRow[], counts: TerritoryCountRow[] = []): TerritoryNode[] {
  const count = new Map(counts.filter((c) => c.territory_id !== null).map((c) => [c.territory_id as string, c]));
  const nodes = new Map<string, TerritoryNode>();
  for (const t of territories) {
    const c = count.get(t.id);
    nodes.set(t.id, {
      territory: t,
      depth: 0,
      children: [],
      customers: c?.customers ?? 0,
      activeCustomers: c?.active_customers ?? 0,
      leads: c?.leads ?? 0,
      employees: c?.employees ?? 0,
      totalCustomers: 0,
      height: 0,
    });
  }
  const roots: TerritoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.territory.parent_id ? nodes.get(node.territory.parent_id) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const seen = new Set<string>();
  const walk = (node: TerritoryNode, depth: number): void => {
    seen.add(node.territory.id);
    node.depth = depth;
    node.children = node.children.filter((c) => !seen.has(c.territory.id)).sort(byCode);
    for (const child of node.children) walk(child, depth + 1);
    node.totalCustomers = node.customers + node.children.reduce((sum, c) => sum + c.totalCustomers, 0);
    node.height = node.children.length === 0 ? 0 : 1 + Math.max(...node.children.map((c) => c.height));
  };
  roots.sort(byCode);
  for (const root of roots) walk(root, 0);
  return roots;
}

/** Depth-first order, for rendering the tree as an indented list. */
export function flattenTree(roots: TerritoryNode[]): TerritoryNode[] {
  const out: TerritoryNode[] = [];
  const visit = (n: TerritoryNode) => {
    out.push(n);
    n.children.forEach(visit);
  };
  roots.forEach(visit);
  return out;
}

/** Ids of a node and everything below it. */
export function subtreeIds(node: TerritoryNode): Set<string> {
  return new Set(flattenTree([node]).map((n) => n.territory.id));
}

/**
 * Parents a territory may move under: active, not itself or below it (TERRITORY_CYCLE), not its
 * current parent, and with room for its subtree (TERRITORY_TOO_DEEP). Becoming a region (no
 * parent) is offered separately.
 */
export function moveTargets(flat: TerritoryNode[], node: TerritoryNode): TerritoryNode[] {
  const own = subtreeIds(node);
  return flat.filter(
    (n) =>
      !own.has(n.territory.id) &&
      n.territory.is_active &&
      n.territory.id !== node.territory.parent_id &&
      n.depth + 1 + node.height <= MAX_TERRITORY_DEPTH,
  );
}

/** Territories a new one may be created under (active, not at the deepest level). */
export function parentOptions(flat: TerritoryNode[]): TerritoryNode[] {
  return flat.filter((n) => n.territory.is_active && n.depth < MAX_TERRITORY_DEPTH);
}

/** Deactivation needs every child inactive first (TERRITORY_HAS_CHILDREN). */
export function canDeactivate(node: TerritoryNode): boolean {
  return node.territory.is_active && node.children.every((c) => !c.territory.is_active);
}

/** Reactivation needs an active parent; `parent` undefined = a root. */
export function canReactivate(node: TerritoryNode, parent: TerritoryNode | undefined): boolean {
  return !node.territory.is_active && (parent === undefined || parent.territory.is_active);
}

/** Customers without a territory (the NULL row of api.territory_customer_counts), if visible. */
export function unassignedCustomers(counts: TerritoryCountRow[]): number | null {
  const row = counts.find((c) => c.territory_id === null);
  return row ? row.customers : null;
}
