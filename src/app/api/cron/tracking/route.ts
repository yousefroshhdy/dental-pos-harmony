import { NextResponse } from "next/server";
import { serverEnv } from "@/env";
import { log } from "@/lib/log";
import { isAuthorizedCron } from "@/lib/outbox/cron-auth";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "Cache-Control": "no-store" };

/**
 * Work-hours tracking jobs (D-14). Vercel Cron calls GET with
 * `Authorization: Bearer $CRON_SECRET`; POST is accepted for manual runs.
 *   1. service.tracking_auto_close(): closes shifts open past tracking.max_shift_hours
 *   2. service.tracking_purge(): keeps daily summaries, deletes points older than
 *      tracking.retention_days, logs a security event
 * The commands also close the caller's own stale shift, so a daily run is enough
 * for correctness; run it more often to close forgotten shifts sooner.
 * Logs carry counts only — never coordinates or ids of people.
 */
async function handle(request: Request): Promise<NextResponse> {
  const requestId = request.headers.get("x-vercel-id") ?? crypto.randomUUID();

  let env: ReturnType<typeof serverEnv<"CRON_SECRET">>;
  try {
    env = serverEnv("CRON_SECRET");
  } catch (err) {
    log("error", "tracking.cron_misconfigured", { request_id: requestId, error: err instanceof Error ? err.message : "unknown" });
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: noStore });
  }

  if (!isAuthorizedCron(request.headers.get("authorization"), env.CRON_SECRET)) {
    log("warn", "tracking.cron_unauthorized", { request_id: requestId });
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }

  const supabase = createServiceClient();
  const started = Date.now();
  try {
    const closed = await supabase.rpc("tracking_auto_close");
    if (closed.error) throw new Error(`tracking_auto_close: ${closed.error.code ?? ""} ${closed.error.message}`);
    const purged = await supabase.rpc("tracking_purge");
    if (purged.error) throw new Error(`tracking_purge: ${purged.error.code ?? ""} ${purged.error.message}`);
    const summary = { auto_closed: Number(closed.data ?? 0), purge: purged.data ?? null };
    log("info", "tracking.cron", { request_id: requestId, ...summary, duration_ms: Date.now() - started });
    return NextResponse.json(summary, { headers: noStore });
  } catch (err) {
    log("error", "tracking.cron_failed", {
      request_id: requestId,
      duration_ms: Date.now() - started,
      error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
    });
    return NextResponse.json({ error: "tracking_jobs_failed" }, { status: 500, headers: noStore });
  }
}

export function GET(request: Request) {
  return handle(request);
}

export function POST(request: Request) {
  return handle(request);
}
