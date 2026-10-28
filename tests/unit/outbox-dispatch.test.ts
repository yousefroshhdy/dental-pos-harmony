import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimedEvent, DeliveryResult, FetchLike } from "@/lib/outbox/deliver";
import { CLAIM_BATCH, MAX_EVENTS_PER_RUN, parseClaimed, runDispatch, type OutboxStore } from "@/lib/outbox/dispatch";

const SECRET = "whsec_test_0123456789abcdef0123456789abcdef";

function makeEvent(i: number): ClaimedEvent {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    event_type: "order.submitted",
    aggregate_type: "order",
    aggregate_id: "7a000000-0000-4000-8000-000000000001",
    payload: { secret_field: "do-not-log" },
    attempts: 0,
    created_at: "2026-11-02T07:15:00+00:00",
    targets: ["https://a.example.test/hook"],
  };
}

function fakeStore(queue: ClaimedEvent[]) {
  const reports: { id: string; result: DeliveryResult }[] = [];
  const claims: number[] = [];
  const store: OutboxStore = {
    async claim(limit) {
      claims.push(limit);
      return queue.splice(0, limit);
    },
    async report(id, result) {
      reports.push({ id, result });
    },
  };
  return { store, reports, claims };
}

afterEach(() => vi.restoreAllMocks());

describe("runDispatch", () => {
  it("delivers, reports every event and summarises", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store, reports } = fakeStore([makeEvent(1), makeEvent(2), makeEvent(3)]);
    let n = 0;
    const fetchImpl: FetchLike = async () => new Response(null, { status: ++n === 2 ? 500 : 200 });
    const summary = await runDispatch({ store, secret: SECRET, fetchImpl });
    expect(summary).toEqual({ claimed: 3, delivered: 2, failed: 1 });
    expect(reports).toHaveLength(3);
    expect(reports.filter((r) => !r.result.ok)[0]!.result.status).toBe(500);
  });

  it("claims in batches and stops at the per-run cap", async () => {
    const { store, claims } = fakeStore(Array.from({ length: 250 }, (_, i) => makeEvent(i)));
    const summary = await runDispatch({ store, secret: SECRET, fetchImpl: async () => new Response(null, { status: 200 }) });
    expect(summary.claimed).toBe(MAX_EVENTS_PER_RUN);
    expect(claims.every((l) => l <= CLAIM_BATCH)).toBe(true);
  });

  it("stops claiming once the time budget is spent", async () => {
    const { store, claims } = fakeStore(Array.from({ length: 50 }, (_, i) => makeEvent(i)));
    let t = 0;
    const summary = await runDispatch({
      store,
      secret: SECRET,
      clock: () => (t += 20_000),
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    expect(claims).toHaveLength(1);
    expect(summary.claimed).toBe(CLAIM_BATCH);
  });

  it("keeps going when reporting one result fails, and never logs payloads", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((l: string) => void lines.push(l));
    vi.spyOn(console, "warn").mockImplementation((l: string) => void lines.push(l));
    const { store } = fakeStore([makeEvent(1), makeEvent(2)]);
    const failingStore: OutboxStore = {
      claim: store.claim,
      report: async (id) => {
        if (id.endsWith("1")) throw new Error("outbox_result: P0001 INVALID_STATE");
      },
    };
    const summary = await runDispatch({ store: failingStore, secret: SECRET, fetchImpl: async () => new Response(null, { status: 502 }) });
    expect(summary).toEqual({ claimed: 2, delivered: 0, failed: 2 });
    expect(lines.some((l) => l.includes("outbox.report_failed"))).toBe(true);
    expect(lines.join("\n")).not.toContain("do-not-log");
    expect(lines.join("\n")).not.toContain("/hook");
  });
});

describe("parseClaimed", () => {
  it("accepts rows from service.outbox_claim and rejects malformed ones", () => {
    expect(parseClaimed([makeEvent(1)])).toHaveLength(1);
    expect(parseClaimed(null)).toEqual([]);
    expect(() => parseClaimed([{ ...makeEvent(1), targets: [] }])).toThrow();
  });
});
