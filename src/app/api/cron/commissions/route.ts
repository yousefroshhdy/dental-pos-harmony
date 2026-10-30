import { NextResponse } from "next/server";
import { serverEnv } from "@/env";
import { log } from "@/lib/log";
import { isAuthorizedCron } from "@/lib/outbox/cron-auth";
import { createServiceClient } from "@/lib/supabase/admin";
import { parseCommissionRun } from "@/modules/commissions/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "Cache-Control": "no-store" };

/**
 * Commission run (docs/DASHBOARDS.md §3). Vercel Cron calls GET with
 * `Authorization: Bearer $CRON_SECRET`; POST is accepted for manual runs.
 * service.commission_run() closes every month whose close date (day 6 of the next
 * month, Cairo) has passed, oldest first, then recalculates the open months. It is
 * idempotent: a repeated or overlapping run changes nothing twice (the engine holds
 * a transaction lock). Logs carry months and counts only.
 */
async function handle(request: Request): Promise<NextResponse> {
  const requestId = request.headers.get("x-vercel-id") ?? crypto.randomUUID();

  let env: ReturnType<typeof serverEnv<"CRON_SECRET">>;
  try {
    env = serverEnv("CRON_SECRET");
  } catch (err) {
    log("error", "commissions.misconfigured", { request_id: requestId, error: err instanceof Error ? err.message : "unknown" });
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: noStore });
  }

  if (!isAuthorizedCron(request.headers.get("authorization"), env.CRON_SECRET)) {
    log("warn", "commissions.unauthorized", { request_id: requestId });
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }

  const started = Date.now();
  try {
    const { data, error } = await createServiceClient().rpc("commission_run", {});
    if (error) throw new Error(`commission_run: ${error.code ?? ""} ${error.message}`);
    const summary = parseCommissionRun(data);
    log("info", "commissions.run", { request_id: requestId, ...summary, duration_ms: Date.now() - started });
    return NextResponse.json(summary, { headers: noStore });
  } catch (err) {
    log("error", "commissions.run_failed", {
      request_id: requestId,
      duration_ms: Date.now() - started,
      error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
    });
    return NextResponse.json({ error: "run_failed" }, { status: 500, headers: noStore });
  }
}

export function GET(request: Request) {
  return handle(request);
}

export function POST(request: Request) {
  return handle(request);
}
