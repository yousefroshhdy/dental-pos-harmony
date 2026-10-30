import { NextResponse } from "next/server";
import { serverEnv } from "@/env";
import { log } from "@/lib/log";
import { isAuthorizedCron } from "@/lib/outbox/cron-auth";
import { createServiceClient } from "@/lib/supabase/admin";
import { parseOverdueScan } from "@/modules/finance/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "Cache-Control": "no-store" };

/**
 * Overdue scan (docs/API_CONTRACTS.md §4). Vercel Cron calls GET with
 * `Authorization: Bearer $CRON_SECRET`; POST is accepted for manual runs.
 * service.finance_overdue_scan() opens one collection task per newly overdue
 * invoice and emits `invoice.overdue`; it is idempotent, so a repeated or
 * overlapping run creates nothing twice. Logs carry counts only.
 */
async function handle(request: Request): Promise<NextResponse> {
  const requestId = request.headers.get("x-vercel-id") ?? crypto.randomUUID();

  let env: ReturnType<typeof serverEnv<"CRON_SECRET">>;
  try {
    env = serverEnv("CRON_SECRET");
  } catch (err) {
    log("error", "overdue.misconfigured", { request_id: requestId, error: err instanceof Error ? err.message : "unknown" });
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: noStore });
  }

  if (!isAuthorizedCron(request.headers.get("authorization"), env.CRON_SECRET)) {
    log("warn", "overdue.unauthorized", { request_id: requestId });
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }

  const started = Date.now();
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase.rpc("finance_overdue_scan", { p_limit: 500 });
    if (error) throw new Error(`finance_overdue_scan: ${error.code ?? ""} ${error.message}`);
    const summary = parseOverdueScan(data);
    log("info", "overdue.scan", { request_id: requestId, ...summary, duration_ms: Date.now() - started });
    return NextResponse.json(summary, { headers: noStore });
  } catch (err) {
    log("error", "overdue.scan_failed", {
      request_id: requestId,
      duration_ms: Date.now() - started,
      error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
    });
    return NextResponse.json({ error: "scan_failed" }, { status: 500, headers: noStore });
  }
}

export function GET(request: Request) {
  return handle(request);
}

export function POST(request: Request) {
  return handle(request);
}
