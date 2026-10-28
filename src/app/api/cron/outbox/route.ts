import { NextResponse } from "next/server";
import { serverEnv } from "@/env";
import { log } from "@/lib/log";
import { isAuthorizedCron } from "@/lib/outbox/cron-auth";
import { parseClaimed, runDispatch, type OutboxStore } from "@/lib/outbox/dispatch";
import { createServiceClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const noStore = { "Cache-Control": "no-store" };

/**
 * Outbox dispatcher (docs/INTEGRATIONS.md §3). Vercel Cron calls GET with
 * `Authorization: Bearer $CRON_SECRET`; POST is accepted for manual runs.
 * Logs carry ids, types and statuses only — never payloads, URLs or secrets.
 */
async function handle(request: Request): Promise<NextResponse> {
  const requestId = request.headers.get("x-vercel-id") ?? crypto.randomUUID();

  let env: ReturnType<typeof serverEnv<"CRON_SECRET" | "OUTBOX_SIGNING_SECRET">>;
  try {
    env = serverEnv("CRON_SECRET", "OUTBOX_SIGNING_SECRET");
  } catch (err) {
    log("error", "outbox.misconfigured", { request_id: requestId, error: err instanceof Error ? err.message : "unknown" });
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: noStore });
  }

  if (!isAuthorizedCron(request.headers.get("authorization"), env.CRON_SECRET)) {
    log("warn", "outbox.unauthorized", { request_id: requestId });
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }

  const supabase = createServiceClient();
  const store: OutboxStore = {
    async claim(limit) {
      const { data, error } = await supabase.rpc("outbox_claim", { p_limit: limit });
      if (error) throw new Error(`outbox_claim: ${error.code ?? ""} ${error.message}`);
      return parseClaimed(data);
    },
    async report(id, result) {
      const { error } = await supabase.rpc("outbox_result", {
        p_id: id,
        p_ok: result.ok,
        p_http_status: result.status,
        p_error: result.error,
      });
      if (error) throw new Error(`outbox_result: ${error.code ?? ""} ${error.message}`);
    },
  };

  const started = Date.now();
  try {
    const summary = await runDispatch({ store, secret: env.OUTBOX_SIGNING_SECRET, requestId });
    log("info", "outbox.dispatch", { request_id: requestId, ...summary, duration_ms: Date.now() - started });
    return NextResponse.json(summary, { headers: noStore });
  } catch (err) {
    log("error", "outbox.dispatch_failed", {
      request_id: requestId,
      duration_ms: Date.now() - started,
      error: err instanceof Error ? err.message.slice(0, 300) : "unknown",
    });
    return NextResponse.json({ error: "dispatch_failed" }, { status: 500, headers: noStore });
  }
}

export function GET(request: Request) {
  return handle(request);
}

export function POST(request: Request) {
  return handle(request);
}
