import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * True when the Authorization header is exactly `Bearer <secret>`.
 * Both sides are hashed to fixed-length digests before the constant-time
 * compare, so neither the content nor the length of the secret leaks.
 */
export function isAuthorizedCron(authorization: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret || !authorization) return false;
  const given = createHash("sha256").update(authorization, "utf8").digest();
  const expected = createHash("sha256").update(`Bearer ${secret}`, "utf8").digest();
  return timingSafeEqual(given, expected);
}
