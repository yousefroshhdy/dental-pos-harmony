import { NextResponse } from "next/server";
import { serverEnv } from "@/env";
import { log } from "@/lib/log";
import { isAuthorizedCron } from "@/lib/outbox/cron-auth";
import { placesServerKey } from "@/lib/places/client";
import { createServiceClient } from "@/lib/supabase/admin";
import { runQueuedDiscovery } from "@/modules/leads/discovery";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "Cache-Control": "no-store" };
/** Stop starting Google requests well before the 60 s function limit. */
const BUDGET_MS = 45_000;

/**
 * Lead discovery (Phase P step 4). Vercel Cron calls GET daily (Hobby allows daily crons only)
 * with `Authorization: Bearer $CRON_SECRET`; POST is accepted for manual runs.
 *   1. service.leads_daily(): clears lead distances older than 30 days (Places caching limit)
 *      and queues a monthly refresh run per rep;
 *   2. the queued runs, oldest first, each claimed within the cost caps
 *      (leads.daily_request_cap, leads.monthly_budget_usd) and asked to Google with the server
 *      key. Without GOOGLE_MAPS_SERVER_KEY every queued run ends as "not_configured".
 * Logs carry counts and statuses only: never place ids, coordinates or names.
 */
async function handle(request: Request): Promise<NextResponse> {
  const requestId = request.headers.get("x-vercel-id") ?? crypto.randomUUID();

  let env: ReturnType<typeof serverEnv<"CRON_SECRET">>;
  try {
    env = serverEnv("CRON_SECRET");
  } catch (err) {
    log("error", "leads.cron_misconfigured", { request_id: requestId, error: err instanceof Error ? err.message : "unknown" });
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: noStore });
  }

  if (!isAuthorizedCron(request.headers.get("authorization"), env.CRON_SECRET)) {
    log("warn", "leads.cron_unauthorized", { request_id: requestId });
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }

  const supabase = createServiceClient();
  const started = Date.now();
  try {
    const daily = await supabase.rpc("leads_daily");
    if (daily.error) throw new Error(`leads_daily: ${daily.error.code ?? ""} ${daily.error.message}`);
    const key = placesServerKey();
    const outcomes = await runQueuedDiscovery({
      rpc: (fn, args) => supabase.rpc(fn, args),
      key,
      deadline: started + BUDGET_MS,
    });
    const byStatus: Record<string, number> = {};
    let requests = 0;
    for (const o of outcomes) {
      byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      if ("requests" in o) requests += o.requests;
    }
    const summary = { key_configured: key.status === "ready", housekeeping: daily.data ?? null, runs: outcomes.length, by_status: byStatus, requests };
    log("info", "leads.cron", { request_id: requestId, ...summary, duration_ms: Date.now() - started });
    return NextResponse.json(summary, { headers: noStore });
  } catch (err) {
    log("error", "leads.cron_failed", {
      request_id: requestId,
      duration_ms: Date.now() - started,
      error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
    });
    return NextResponse.json({ error: "lead_jobs_failed" }, { status: 500, headers: noStore });
  }
}

export function GET(request: Request) {
  return handle(request);
}

export function POST(request: Request) {
  return handle(request);
}
