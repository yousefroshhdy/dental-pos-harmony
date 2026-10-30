/**
 * Shapes returned by the audit row-image reader
 * (supabase/migrations/20261103001100_audit_row_image_reader.sql).
 */

export const AUDIT_ACTIONS = ["INSERT", "UPDATE", "DELETE"] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Categories in audit.row_image_masks. A masked value reads "[masked:<category>]". */
export const MASK_CATEGORIES = ["cost", "balance", "credit_limit", "phone", "email", "gps"] as const;
export type MaskCategory = (typeof MASK_CATEGORIES)[number];

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type RowImage = Record<string, Json>;

/** One row of api.audit_search / api.audit_record_history. */
export interface AuditEntry {
  id: number;
  occurred_at: string;
  actor_user_id: string | null;
  actor_name_en: string | null;
  actor_name_ar: string | null;
  action: AuditAction;
  table_schema: string;
  table_name: string;
  record_id: string | null;
  changed_fields: string[] | null;
  request_id: string | null;
  old_data: RowImage | null;
  new_data: RowImage | null;
  /** Masked paths → category ("phone_primary": "phone", "payload.credit_limit": "credit_limit"). */
  masked: Record<string, string> | null;
}

/** One row of api.audit_tables. */
export interface AuditTable {
  table_schema: string;
  table_name: string;
}

/** Actor filter option (api.v_users). */
export interface ActorOption {
  user_id: string;
  employee_no: string | null;
  full_name_en: string | null;
  full_name_ar: string | null;
}

/** Validated search filters (from the URL). */
export interface AuditFilters {
  tableSchema?: string;
  tableName?: string;
  recordId?: string;
  actorUserId?: string;
  from?: string;
  to?: string;
  action?: AuditAction;
  beforeId?: number;
  reveal: boolean;
}
