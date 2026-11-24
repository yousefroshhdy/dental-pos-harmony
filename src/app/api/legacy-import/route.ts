import { handleLegacyUpload } from "@/modules/imports/legacy/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Upload of the old-system workbook from /admin/setup/legacy-import (owner only, MFA). Why a route
 * handler and not a Server Action, and every check it runs: src/modules/imports/legacy/server.ts.
 */
export async function POST(request: Request) {
  return handleLegacyUpload(request);
}
