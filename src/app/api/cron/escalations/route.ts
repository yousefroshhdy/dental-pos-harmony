import { NextResponse } from "next/server";
import { serverEnv } from "@/env";
import { log } from "@/lib/log";
import { isAuthorizedCron } from "@/lib/outbox/cron-auth";
import { createServiceClient } from "@/lib/supabase/admin";
import { ESCALATION_BATCH, parseEscalationRun } from "@/modules/workflow/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "Cache-Control": "no-store" };

/**
 * Approval escalation job (docs/TESTING.md §2.4). Vercel Cron calls GET with
 * `Authorization: Bearer $CRON_SECRET`; POST is accepted for manual runs.
 * service.workflow_escalate() escalates pending requests whose current stage
 * waited past escalate_after by one level (the stage's fallback, the
 * approver's manager, else the owners), notifies them and emits
 * `approval.escalated`. It is idempotent, so a repeated or overlapping run
 * escalates nothing twice. Logs carry counts only.
 */
async function handle(request: Request): Promise<NextResponse> {
  const requestId = request.headers.get("x-vercel-id") ?? crypto.randomUUID();

  let env: ReturnType<typeof serverEnv<"CRON_SECRET">>;
  try {
    env = serverEnv("CRON_SECRET");
  } catch (err) {
    log("error", "escalations.misconfigured", { request_id: requestId, error: err instanceof Error ? err.message : "unknown" });
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: noStore });
  }

  if (!isAuthorizedCron(request.headers.get("authorization"), env.CRON_SECRET)) {
    log("warn", "escalations.unauthorized", { request_id: requestId });
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }

  const started = Date.now();
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase.rpc("workflow_escalate", { p_limit: ESCALATION_BATCH });
    if (error) throw new Error(`workflow_escalate: ${error.code ?? ""} ${error.message}`);
    const summary = parseEscalationRun(data);
    log("info", "escalations.run", { request_id: requestId, ...summary, duration_ms: Date.now() - started });
    return NextResponse.json(summary, { headers: noStore });
  } catch (err) {
    log("error", "escalations.run_failed", {
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
