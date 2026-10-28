import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildHeaders, signPayload, verifySignature } from "@/lib/outbox/sign";

const SECRET = "whsec_test_0123456789abcdef0123456789abcdef";
const TS = 1767225600; // 2026-01-01T00:00:00Z
const BODY = '{"id":"6f1c","type":"order.submitted"}';

describe("signPayload", () => {
  it("matches a fixed vector computed outside the code (openssl dgst -sha256 -hmac)", () => {
    expect(signPayload(SECRET, TS, BODY)).toBe("sha256=0b93b570329138f07ad533ff3a15efee29190093451adf6081c1ca43a1d08982");
  });

  it("is HMAC-SHA256 over `${timestamp}.${rawBody}` in lowercase hex", () => {
    const expected = createHmac("sha256", SECRET).update(`${TS}.${BODY}`).digest("hex");
    expect(signPayload(SECRET, TS, BODY)).toBe(`sha256=${expected}`);
    expect(signPayload(SECRET, TS, BODY)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("signs UTF-8 bytes (Arabic text)", () => {
    const body = '{"name":"عيادة د. أحمد"}';
    const expected = createHmac("sha256", SECRET).update(Buffer.from(`${TS}.${body}`, "utf8")).digest("hex");
    expect(signPayload(SECRET, TS, body)).toBe(`sha256=${expected}`);
  });
});

describe("buildHeaders", () => {
  const now = new Date(TS * 1000 + 999);
  const headers = buildHeaders({ id: "6f1c2b9e-0000-4000-8000-000000000001", event_type: "order.pending_approval" }, BODY, SECRET, now);

  it("produces exactly the contract headers", () => {
    expect(Object.keys(headers).sort()).toEqual(
      ["Content-Type", "X-Honest-Event", "X-Honest-Event-Id", "X-Honest-Signature", "X-Honest-Timestamp"].sort(),
    );
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Honest-Event"]).toBe("order.pending_approval");
    expect(headers["X-Honest-Event-Id"]).toBe("6f1c2b9e-0000-4000-8000-000000000001");
  });

  it("uses unix seconds and signs with that timestamp", () => {
    expect(headers["X-Honest-Timestamp"]).toBe(String(TS));
    expect(headers["X-Honest-Signature"]).toBe(signPayload(SECRET, TS, BODY));
  });
});

describe("verifySignature", () => {
  const signature = signPayload(SECRET, TS, BODY);
  const base = { secret: SECRET, timestamp: String(TS), signature, rawBody: BODY, now: new Date(TS * 1000 + 60_000) };

  it("accepts a valid signature within 5 minutes", () => {
    expect(verifySignature(base)).toBe(true);
    expect(verifySignature({ ...base, now: new Date((TS + 300) * 1000) })).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifySignature({ ...base, rawBody: BODY.replace("submitted", "approved") })).toBe(false);
  });

  it("rejects a stale or far-future timestamp", () => {
    expect(verifySignature({ ...base, now: new Date((TS + 301) * 1000) })).toBe(false);
    expect(verifySignature({ ...base, now: new Date((TS - 301) * 1000) })).toBe(false);
  });

  it("rejects a re-dated timestamp (timestamp is signed)", () => {
    expect(verifySignature({ ...base, timestamp: String(TS + 60) })).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifySignature({ ...base, secret: "another-secret-another-secret-0000" })).toBe(false);
  });

  it("rejects missing or malformed headers without throwing", () => {
    expect(verifySignature({ ...base, signature: null })).toBe(false);
    expect(verifySignature({ ...base, timestamp: undefined })).toBe(false);
    expect(verifySignature({ ...base, timestamp: "1767225600.5" })).toBe(false);
    expect(verifySignature({ ...base, signature: "sha256=abc" })).toBe(false);
    expect(verifySignature({ ...base, signature: signature.toUpperCase() })).toBe(false);
    expect(verifySignature({ ...base, secret: "" })).toBe(false);
  });
});
