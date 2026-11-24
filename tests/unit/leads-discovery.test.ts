import { describe, expect, it, vi } from "vitest";
import { runDiscoveryJob, runQueuedDiscovery, type ServiceRpc } from "@/modules/leads/discovery";

const KEY = "AIzaSyTEST_test_key_000000000000000000";
const RUN = "11111111-1111-4111-8111-111111111111";

function rpcMock(answers: Record<string, unknown[]>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const queues = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, [...v]]));
  const rpc: ServiceRpc = async (fn, args) => {
    calls.push({ fn, args });
    const next = queues[fn]?.shift();
    return { data: next ?? null, error: null };
  };
  return { rpc, calls };
}

const noFetch = vi.fn(async () => {
  throw new Error("no Google request may be made");
}) as unknown as typeof fetch;

describe("discovery job", () => {
  it("without a server key: the claim says not configured, and no Google request is made", async () => {
    const { rpc, calls } = rpcMock({ leads_claim_run: [{ status: "not_configured", run_id: RUN }] });
    const out = await runDiscoveryJob({ rpc, key: { status: "not_configured" }, fetchImpl: noFetch });
    expect(out).toEqual({ status: "not_configured", runId: RUN });
    expect(calls).toEqual([{ fn: "leads_claim_run", args: { p_run_id: null, p_key_configured: false } }]);
    expect(noFetch).not.toHaveBeenCalled();
  });

  it("a refused run (cap) makes no request", async () => {
    const { rpc } = rpcMock({ leads_claim_run: [{ status: "refused", run_id: RUN, reason: "monthly_budget" }] });
    expect(await runDiscoveryJob({ rpc, key: { status: "ready", key: KEY }, runId: RUN, fetchImpl: noFetch })).toEqual({
      status: "refused",
      runId: RUN,
      reason: "monthly_budget",
    });
  });

  it("a claimed run asks Google within its budget and hands back counts and places", async () => {
    const { rpc, calls } = rpcMock({
      leads_claim_run: [{ status: "claimed", run_id: RUN, center: { lat: 31.0409, lng: 31.3785 }, radius_m: 800, max_requests: 5 }],
      leads_finish_run: [{ run_id: RUN, status: "done", leads_new: 1 }],
    });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      new Response(
        JSON.stringify(
          String(url).endsWith("searchNearby") ? { places: [{ id: "ChIJsynthPlace000001", location: { latitude: 31.0409, longitude: 31.379 } }] } : { places: [] },
        ),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const out = await runDiscoveryJob({ rpc, key: { status: "ready", key: KEY }, fetchImpl });
    expect(out).toEqual({ status: "done", runId: RUN, requests: 2, leadsNew: 1, truncated: false, errorCode: null });
    const finish = calls.find((c) => c.fn === "leads_finish_run");
    expect(finish?.args).toMatchObject({ p_run_id: RUN, p_status: "done", p_nearby_requests: 1, p_text_requests: 1, p_truncated: false, p_error_code: null });
    expect(finish?.args.p_places).toEqual([{ place_id: "ChIJsynthPlace000001", lat: 31.0409, lng: 31.379, distance_m: expect.any(Number) }]);
  });

  it("a Google key error records the run as failed", async () => {
    const { rpc, calls } = rpcMock({
      leads_claim_run: [{ status: "claimed", run_id: RUN, center: { lat: 31.04, lng: 31.37 }, radius_m: 5000, max_requests: 200 }],
      leads_finish_run: [{ run_id: RUN, status: "failed", leads_new: 0 }],
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED" } }), { status: 403 })) as unknown as typeof fetch;
    const out = await runDiscoveryJob({ rpc, key: { status: "ready", key: KEY }, fetchImpl });
    expect(out).toMatchObject({ status: "failed", errorCode: "permission_denied", requests: 1 });
    expect(calls.find((c) => c.fn === "leads_finish_run")?.args).toMatchObject({ p_status: "failed", p_error_code: "permission_denied" });
  });

  it("a database error is thrown, not swallowed", async () => {
    const rpc: ServiceRpc = async () => ({ data: null, error: { code: "42501", message: "permission denied" } });
    await expect(runDiscoveryJob({ rpc, key: { status: "not_configured" } })).rejects.toThrow(/leads_claim_run/);
  });

  it("the cron loop stops when nothing waits or a cap refuses", async () => {
    const a = rpcMock({ leads_claim_run: [{ status: "not_configured", run_id: RUN }, { status: "cancelled", run_id: RUN }, { status: "none" }] });
    expect((await runQueuedDiscovery({ rpc: a.rpc, key: { status: "not_configured" } })).map((o) => o.status)).toEqual(["not_configured", "cancelled"]);
    const b = rpcMock({ leads_claim_run: [{ status: "refused", run_id: RUN, reason: "daily_cap" }, { status: "not_configured", run_id: RUN }] });
    expect((await runQueuedDiscovery({ rpc: b.rpc, key: { status: "ready", key: KEY } })).map((o) => o.status)).toEqual(["refused"]);
  });
});
