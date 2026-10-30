import { getUserContext } from "@/lib/authz/context";
import { createClient } from "@/lib/supabase/server";
import { handleExport } from "@/modules/reports/export";
import { exportRowCap } from "@/modules/reports/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * CSV export of a list (docs/DASHBOARDS.md §5, on demand). Runs as the
 * signed-in user: the server client carries the session cookie, so RLS and
 * the views' masking decide every row. The service-role client is never used.
 */
export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  return handleExport(request, kind, { getContext: getUserContext, createClient, rowCap: () => exportRowCap() });
}
