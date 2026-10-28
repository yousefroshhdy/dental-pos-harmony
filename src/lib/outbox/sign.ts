import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Outbound event signing (docs/API_CONTRACTS.md §5).
 *
 *   X-Honest-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
 *
 * The timestamp is part of the signed string so a captured request cannot be
 * replayed after the tolerance window. Consumers also dedupe on X-Honest-Event-Id.
 */
export const SIGNATURE_TOLERANCE_SEC = 300;

export const HEADER_EVENT = "X-Honest-Event";
export const HEADER_EVENT_ID = "X-Honest-Event-Id";
export const HEADER_TIMESTAMP = "X-Honest-Timestamp";
export const HEADER_SIGNATURE = "X-Honest-Signature";

export function signPayload(secret: string, timestampSec: number, rawBody: string): string {
  const mac = createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`, "utf8").digest("hex");
  return `sha256=${mac}`;
}

export interface SignableEvent {
  id: string;
  event_type: string;
}

/** Headers for one delivery. `rawBody` must be the exact bytes that are sent. */
export function buildHeaders(event: SignableEvent, rawBody: string, secret: string, now: Date = new Date()): Record<string, string> {
  const timestamp = Math.floor(now.getTime() / 1000);
  return {
    "Content-Type": "application/json",
    [HEADER_EVENT]: event.event_type,
    [HEADER_EVENT_ID]: event.id,
    [HEADER_TIMESTAMP]: String(timestamp),
    [HEADER_SIGNATURE]: signPayload(secret, timestamp, rawBody),
  };
}

export interface VerifyInput {
  secret: string;
  /** X-Honest-Timestamp header value (unix seconds). */
  timestamp: string | null | undefined;
  /** X-Honest-Signature header value (`sha256=<hex>`). */
  signature: string | null | undefined;
  rawBody: string;
  now?: Date;
  toleranceSec?: number;
}

/**
 * Verifies a signed event as a consumer would: well-formed headers, timestamp
 * within the tolerance (either direction), and a constant-time MAC comparison.
 */
export function verifySignature({ secret, timestamp, signature, rawBody, now = new Date(), toleranceSec = SIGNATURE_TOLERANCE_SEC }: VerifyInput): boolean {
  if (!secret || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const ts = Number(timestamp);
  const nowSec = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSec - ts) > toleranceSec) return false;

  const expected = Buffer.from(signPayload(secret, ts, rawBody), "utf8");
  const given = Buffer.from(signature, "utf8");
  // timingSafeEqual throws on unequal lengths; the expected length is public (fixed).
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
