import { describe, expect, it, vi } from "vitest";
import {
  aggregateResults,
  buildEnvelope,
  classifyResponse,
  deliverEvent,
  deliverToTarget,
  isPermanentStatus,
  type ClaimedEvent,
  type FetchLike,
} from "@/lib/outbox/deliver";
import { verifySignature } from "@/lib/outbox/sign";

const SECRET = "whsec_test_0123456789abcdef0123456789abcdef";
const event: ClaimedEvent = {
  id: "6f1c2b9e-0000-4000-8000-000000000001",
  event_type: "order.submitted",
  aggregate_type: "order",
  aggregate_id: "7a000000-0000-4000-8000-000000000001",
  payload: { order_no: "SO-2026-000123", total: "2234.40" },
  attempts: 0,
  created_at: "2026-11-02T07:15:00+00:00",
  targets: ["https://a.example.test/hook/secret-path", "https://b.example.test/hook"],
};

const respond = (status: number, statusText = ""): FetchLike => async () => new Response(null, { status, statusText });

describe("classifyResponse / isPermanentStatus", () => {
  it("treats every 2xx as delivered", () => {
    expect(classifyResponse(200)).toEqual({ ok: true, status: 200, error: null });
    expect(classifyResponse(204).ok).toBe(true);
    expect(classifyResponse(299).ok).toBe(true);
  });

  it("treats 3xx, 4xx and 5xx as failures", () => {
    expect(classifyResponse(302).ok).toBe(false);
    expect(classifyResponse(404, "Not Found")).toEqual({ ok: false, status: 404, error: "Not Found" });
    expect(classifyResponse(503).ok).toBe(false);
  });

  it("marks 4xx permanent except 408 and 429 (same rule as service.outbox_result)", () => {
    expect(isPermanentStatus(400)).toBe(true);
    expect(isPermanentStatus(401)).toBe(true);
    expect(isPermanentStatus(404)).toBe(true);
    expect(isPermanentStatus(499)).toBe(true);
    expect(isPermanentStatus(408)).toBe(false);
    expect(isPermanentStatus(429)).toBe(false);
    expect(isPermanentStatus(500)).toBe(false);
    expect(isPermanentStatus(null)).toBe(false);
  });
});

describe("deliverToTarget", () => {
  it("POSTs the body with the given headers and no redirect following", async () => {
    const fetchImpl = vi.fn<FetchLike>(respond(202));
    const result = await deliverToTarget("https://a.example.test/hook", '{"x":1}', { "X-Test": "1" }, { fetchImpl });
    expect(result).toEqual({ ok: true, status: 202, error: null });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://a.example.test/hook");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"x":1}');
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports 4xx and 5xx with their status", async () => {
    expect(await deliverToTarget("https://a.example.test", "{}", {}, { fetchImpl: respond(400, "Bad Request") })).toEqual({
      ok: false,
      status: 400,
      error: "Bad Request",
    });
    expect(await deliverToTarget("https://a.example.test", "{}", {}, { fetchImpl: respond(500) })).toEqual({
      ok: false,
      status: 500,
      error: null,
    });
  });

  it("aborts after the timeout and reports TIMEOUT without a status", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const result = await deliverToTarget("https://a.example.test", "{}", {}, { fetchImpl: hang, timeoutMs: 20 });
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toMatch(/^TIMEOUT/);
  });

  it("reports network errors without throwing", async () => {
    const fail: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const result = await deliverToTarget("https://a.example.test", "{}", {}, { fetchImpl: fail });
    expect(result).toEqual({ ok: false, status: null, error: "NETWORK: TypeError: fetch failed" });
  });
});

describe("deliverEvent", () => {
  it("sends the versioned envelope, signed, to every target", async () => {
    const now = new Date("2026-11-02T07:15:30Z");
    const fetchImpl = vi.fn<FetchLike>(respond(200));
    const result = await deliverEvent(event, SECRET, { fetchImpl, now });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchImpl.mock.calls) {
      const body = init.body as string;
      expect(JSON.parse(body)).toEqual({
        id: event.id,
        type: "order.submitted",
        occurred_at: event.created_at,
        version: 1,
        data: event.payload,
      });
      const h = init.headers as Record<string, string>;
      expect(h["X-Honest-Event-Id"]).toBe(event.id);
      expect(
        verifySignature({ secret: SECRET, timestamp: h["X-Honest-Timestamp"], signature: h["X-Honest-Signature"], rawBody: body, now }),
      ).toBe(true);
    }
  });

  it("fails the event when any target fails, preferring a retryable status", async () => {
    const fetchImpl: FetchLike = async (url) =>
      url.startsWith("https://a.") ? new Response(null, { status: 404 }) : new Response(null, { status: 503 });
    const result = await deliverEvent(event, SECRET, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toContain("a.example.test: HTTP 404");
    expect(result.error).toContain("b.example.test: HTTP 503");
    expect(result.error).not.toContain("secret-path");
  });
});

describe("aggregateResults", () => {
  it("is ok only when all targets are ok", () => {
    const ok = { ok: true, status: 200, error: null };
    expect(aggregateResults([{ target: "https://a.test", result: ok }]).ok).toBe(true);
    expect(aggregateResults([]).ok).toBe(false);
  });

  it("reports a permanent status when every failure is permanent", () => {
    const r = aggregateResults([
      { target: "https://a.test", result: { ok: true, status: 200, error: null } },
      { target: "https://b.test", result: { ok: false, status: 410, error: "Gone" } },
    ]);
    expect(r).toMatchObject({ ok: false, status: 410 });
  });
});

describe("buildEnvelope", () => {
  it("never includes routing or retry internals", () => {
    expect(Object.keys(buildEnvelope(event)).sort()).toEqual(["data", "id", "occurred_at", "type", "version"]);
  });
});
