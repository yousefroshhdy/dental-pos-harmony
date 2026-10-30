import { NextResponse, type NextRequest } from "next/server";
import { getUserContext } from "@/lib/authz/context";
import { canRunImports, templateCsv, templateFileName } from "@/modules/imports/logic";
import { kindParam } from "@/modules/imports/schemas";

/**
 * GET /<locale>/imports/templates/<kind> — the CSV template for one import kind: English
 * headers and obviously synthetic example rows (UTF-8 with BOM so Excel shows Arabic).
 * It holds no data; it is still limited to users who may run imports.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ locale: string; kind: string }> }) {
  const { kind } = await params;
  const parsed = kindParam.safeParse(kind);
  if (!parsed.success) return new NextResponse("Not found", { status: 404 });
  const ctx = await getUserContext();
  if (!canRunImports(ctx)) return new NextResponse("Forbidden", { status: 403 });

  return new NextResponse(templateCsv(parsed.data), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${templateFileName(parsed.data)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
