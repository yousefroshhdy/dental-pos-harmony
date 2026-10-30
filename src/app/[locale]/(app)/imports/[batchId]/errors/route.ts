import { NextResponse, type NextRequest } from "next/server";
import { getUserContext } from "@/lib/authz/context";
import { log } from "@/lib/log";
import { canRunImports, rejectsCsv, rejectsFileName } from "@/modules/imports/logic";
import { getBatch, rejectedRows } from "@/modules/imports/queries";
import { batchIdParam } from "@/modules/imports/schemas";

/**
 * GET /<locale>/imports/<batchId>/errors — the rejects report as CSV: spreadsheet row,
 * the errors, then the row as uploaded. Read through the user's session (RLS: only
 * admin.import.run at scope "all" sees staged rows). Never cached.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ locale: string; batchId: string }> }) {
  const { batchId } = await params;
  if (!batchIdParam.safeParse(batchId).success) return new NextResponse("Not found", { status: 404 });
  const ctx = await getUserContext();
  if (!canRunImports(ctx)) return new NextResponse("Forbidden", { status: 403 });

  const batch = await getBatch(batchId);
  if (!batch.ok) return new NextResponse("Unavailable", { status: 503 });
  if (!batch.data) return new NextResponse("Not found", { status: 404 });
  const rows = await rejectedRows(batchId, true);
  if (!rows.ok) return new NextResponse("Unavailable", { status: 503 });

  log("info", "imports.rejects_downloaded", { batchId, rows: rows.data.length });
  return new NextResponse(rejectsCsv(batch.data.kind, rows.data), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${rejectsFileName(batch.data.kind, batchId)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
