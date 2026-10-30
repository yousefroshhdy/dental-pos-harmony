import { NextResponse } from "next/server";
import { serverEnv } from "@/env";
import { log } from "@/lib/log";
import { isAuthorizedCron } from "@/lib/outbox/cron-auth";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "Cache-Control": "no-store" };

/**
 * Nightly KPI snapshot (docs/DASHBOARDS.md §2 "KPI engine mechanics"). Vercel Cron calls
 * GET with `Authorization: Bearer $CRON_SECRET`; POST is accepted for manual runs.
 * service.snapshot_kpis writes perf.kpi_results for the current month and, until it
 * closes on day 5, the previous month (then once more as final). Logs carry counts only.
 */
async function handle(request: Request): Promise<NextResponse> {
  const requestId = request.headers.get("x-vercel-id") ?? crypto.randomUUID();

  let env: ReturnType<typeof serverEnv<"CRON_SECRET">>;
  try {
    env = serverEnv("CRON_SECRET");
  } catch (err) {
    log("error", "kpi_snapshot.misconfigured", { request_id: requestId, error: err instanceof Error ? err.message : "unknown" });
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: noStore });
  }

  if (!isAuthorizedCron(request.headers.get("authorization"), env.CRON_SECRET)) {
    log("warn", "kpi_snapshot.unauthorized", { request_id: requestId });
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }

  const started = Date.now();
  try {
    const { data, error } = await createServiceClient().rpc("snapshot_kpis", {});
    if (error) throw new Error(`snapshot_kpis: ${error.code ?? ""} ${error.message}`);
    const summary = (data ?? {}) as Record<string, unknown>;
    log("info", "kpi_snapshot.done", { request_id: requestId, ...summary, duration_ms: Date.now() - started });
    return NextResponse.json(summary, { headers: noStore });
  } catch (err) {
    log("error", "kpi_snapshot.failed", {
      request_id: requestId,
      duration_ms: Date.now() - started,
      error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
    });
    return NextResponse.json({ error: "snapshot_failed" }, { status: 500, headers: noStore });
  }
}

export function GET(request: Request) {
  return handle(request);
}

export function POST(request: Request) {
  return handle(request);
}
