import type { TableParamOptions } from "@/components/ui/data-table-params";
import type { InboxTab } from "./types";

/**
 * The approvals inbox as a server-paged table (Phase P step 2b). `waiting` sorts
 * by when the current stage started; each tab has its own natural order.
 */
export const INBOX_TABLE = {
  pageSize: 25,
  sortable: ["waiting", "created_at"],
} as const satisfies TableParamOptions;

export const INBOX_SEARCH_COLUMNS = ["customer_name", "customer_no", "requester_name_en", "requester_name_ar", "workflow_name", "variant_sku"] as const;

/** View column and direction for a tab when the user picked no sort. */
export function inboxOrder(tab: InboxTab, sort: { id: string; desc: boolean } | undefined): { column: string; ascending: boolean } {
  if (sort?.id === "waiting") return { column: "stage_started_at", ascending: !sort.desc };
  if (sort?.id === "created_at") return { column: "created_at", ascending: !sort.desc };
  if (tab === "decide") return { column: "stage_started_at", ascending: true };
  if (tab === "mine") return { column: "created_at", ascending: false };
  return { column: "my_decided_at", ascending: false };
}

export const NOTIFICATIONS_TABLE = {
  pageSize: 25,
  sortable: ["created_at"],
  defaultSort: { id: "created_at", desc: true },
} as const satisfies TableParamOptions;
