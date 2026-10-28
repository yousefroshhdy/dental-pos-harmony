/**
 * UI-side permission helpers. These only decide what to SHOW; every rule is
 * enforced again by RLS and api.* commands in Postgres (docs/AUTHORIZATION.md §5).
 */
export const SCOPES = ["own", "team", "territory", "department", "warehouse", "all"] as const;
export type Scope = (typeof SCOPES)[number];

export interface Grant {
  scope: Scope;
  /** NULL = unlimited. */
  limit: number | null;
}

export interface UserContext {
  user_id: string | null;
  active: boolean;
  is_owner: boolean;
  locale: "ar" | "en";
  status: "active" | "suspended" | "disabled" | "unregistered";
  employee: {
    id: string;
    employee_no: string;
    full_name_en: string;
    full_name_ar: string | null;
    job_title: string;
  } | null;
  permissions: Record<string, Grant>;
}

export const ANONYMOUS_CONTEXT: UserContext = {
  user_id: null,
  active: false,
  is_owner: false,
  locale: "ar",
  status: "unregistered",
  employee: null,
  permissions: {},
};

const rank = (scope: Scope) => SCOPES.indexOf(scope);

/** True if the user holds `permission` at `minScope` or wider. */
export function can(ctx: UserContext, permission: string, minScope: Scope = "own"): boolean {
  if (!ctx.active) return false;
  if (ctx.is_owner) return true;
  const grant = ctx.permissions[permission];
  return grant !== undefined && rank(grant.scope) >= rank(minScope);
}

/** Limit for a permission: number, null (unlimited), or undefined (not held). */
export function limitOf(ctx: UserContext, permission: string): number | null | undefined {
  if (!ctx.active) return undefined;
  if (ctx.is_owner) return null;
  const grant = ctx.permissions[permission];
  if (!grant) return undefined;
  return grant.limit === null ? null : Number(grant.limit);
}

export function canAny(ctx: UserContext, permissions: readonly string[]): boolean {
  return permissions.some((p) => can(ctx, p));
}
