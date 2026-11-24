import type { TableParamOptions } from "@/components/ui/data-table-params";
import type { BatchStatus } from "./types";

/** Import history as a server-paged table (Phase P step 2b): newest first. */
export const BATCHES_TABLE = {
  pageSize: 20,
  sortable: ["created_at", "row_count", "error_count"],
  defaultSort: { id: "created_at", desc: true },
} as const satisfies TableParamOptions;

export const BATCH_STATUSES: readonly BatchStatus[] = ["uploaded", "validated", "committed", "failed", "discarded"];

/** The history tab opens by itself when the URL already pages, sorts or filters it. */
export function historyRequested(params: Record<string, string | string[] | undefined>): boolean {
  return ["page", "sort", "q", "status", "tab"].some((k) => params[k] !== undefined && (k !== "tab" || params[k] === "history"));
}
