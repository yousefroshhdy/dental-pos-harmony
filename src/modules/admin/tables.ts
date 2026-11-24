import type { TableParamOptions } from "@/components/ui/data-table-params";
import type { EmployeeFilter } from "./logic";
import type { ProfileStatus } from "./types";

/**
 * Server-paged admin lists (Phase P step 2b). The page reads these options with
 * `readTableParams` and the client table passes the same ones to the URL state,
 * so both agree on page size and the sortable columns. Column ids are UI ids;
 * `*_SORT_COLUMN` maps them to view columns (the name follows the UI language).
 */
export const USERS_TABLE = {
  pageSize: 25,
  sortable: ["employee_no", "name", "status", "created_at"],
  defaultSort: { id: "employee_no", desc: false },
} as const satisfies TableParamOptions;

export const EMPLOYEES_TABLE = {
  pageSize: 25,
  sortable: ["employee_no", "name", "hired_on"],
  defaultSort: { id: "employee_no", desc: false },
} as const satisfies TableParamOptions;

export const ROLES_TABLE = {
  pageSize: 25,
  sortable: ["code", "name"],
  defaultSort: { id: "code", desc: false },
} as const satisfies TableParamOptions;

export const SECURITY_EVENTS_TABLE = {
  pageSize: 50,
  sortable: ["occurred_at", "severity"],
  defaultSort: { id: "occurred_at", desc: true },
} as const satisfies TableParamOptions;

export const SEVERITIES = ["info", "warning", "critical"] as const;

export const USER_STATUSES: readonly ProfileStatus[] = ["active", "suspended", "disabled"];

/** View column behind a UI sort id. Unknown ids fall back to the default column. */
export function sortColumn(
  id: string | undefined,
  locale: string,
  fallback: string,
  names: { en: string; ar: string } = { en: "full_name_en", ar: "full_name_ar" },
): string {
  if (id === "name") return locale === "ar" ? names.ar : names.en;
  return id ?? fallback;
}

/** Text columns the search box matches (ilike), per list. */
export const USER_SEARCH_COLUMNS = ["full_name_en", "full_name_ar", "email", "employee_no", "job_title"] as const;
export const EMPLOYEE_SEARCH_COLUMNS = ["full_name_en", "full_name_ar", "employee_no", "job_title", "email"] as const;
export const ROLE_SEARCH_COLUMNS = ["code", "name_en", "name_ar"] as const;

/** Employment statuses a filter keeps; null keeps every row. Mirrors logic.matchesEmployeeFilter. */
export function employeeStatusesFor(filter: EmployeeFilter): { include: boolean; statuses: readonly string[] } | null {
  if (filter === "all") return null;
  return { include: filter === "inactive", statuses: ["suspended", "terminated"] };
}
