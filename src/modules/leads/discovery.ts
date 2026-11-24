import "server-only";
import type { PlacesKey } from "@/lib/places/client";
import { discoverPlaces } from "@/lib/places/discover";
import { parseClaim } from "./logic";
import type { JobOutcome } from "./types";

/**
 * One lead-discovery job (Phase P step 4), shared by the daily cron and the owner's "Run now".
 * The database plans and records (service.leads_claim_run / service.leads_finish_run, service
 * role); this code only talks to Google. Without a server key the claim ends the run as
 * "not_configured" and no request is made.
 */

export type ServiceRpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }>;

export interface JobInput {
  rpc: ServiceRpc;
  key: PlacesKey;
  /** A specific queued run ("Run now"); otherwise the oldest queued run. */
  runId?: string;
  fetchImpl?: typeof fetch;
  /** Epoch ms after which no new Google request starts. */
  deadline?: number;
}

async function call(rpc: ServiceRpc, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.code ?? ""} ${(error.message ?? "").slice(0, 200)}`);
  return data;
}

export async function runDiscoveryJob(input: JobInput): Promise<JobOutcome> {
  const claim = parseClaim(
    await call(input.rpc, "leads_claim_run", {
      p_run_id: input.runId ?? null,
      p_key_configured: input.key.status === "ready",
    }),
  );
  if (claim.status === "invalid") throw new Error("leads_claim_run: unexpected answer");
  if (claim.status !== "claimed") return claim;
  if (input.key.status !== "ready") throw new Error("leads_claim_run: claimed without a key");

  let result;
  try {
    result = await discoverPlaces({
      key: input.key.key,
      center: claim.center,
      radiusM: claim.radiusM,
      maxRequests: claim.maxRequests,
      fetchImpl: input.fetchImpl,
      deadline: input.deadline,
    });
  } catch {
    result = { places: [], nearbyRequests: 0, textRequests: 0, truncated: false, errorCode: "client_error" };
  }

  const status = result.errorCode ? "failed" : "done";
  const finished = (await call(input.rpc, "leads_finish_run", {
    p_run_id: claim.runId,
    p_status: status,
    p_nearby_requests: result.nearbyRequests,
    p_text_requests: result.textRequests,
    p_truncated: result.truncated,
    p_error_code: result.errorCode,
    p_places: result.places,
  })) as { leads_new?: unknown } | null;

  return {
    status,
    runId: claim.runId,
    requests: result.nearbyRequests + result.textRequests,
    leadsNew: Number(finished?.leads_new ?? 0) || 0,
    truncated: result.truncated,
    errorCode: result.errorCode,
  };
}

/** Run queued jobs one after another until none is left, a cap refuses, or time is up. */
export async function runQueuedDiscovery(input: Omit<JobInput, "runId"> & { maxJobs?: number }): Promise<JobOutcome[]> {
  const out: JobOutcome[] = [];
  const maxJobs = input.maxJobs ?? 10;
  while (out.length < maxJobs && (input.deadline === undefined || Date.now() < input.deadline)) {
    const o = await runDiscoveryJob(input);
    if (o.status === "none") break;
    out.push(o);
    if (o.status === "refused") break; // the caps are company-wide: the next run would be refused too
  }
  return out;
}
