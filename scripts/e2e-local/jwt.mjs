// LOCAL TEST HARNESS ONLY (docs/TESTING.md "Local signed-in stack"). Node built-ins only.
// HS256 JSON Web Tokens with the per-run secret from .cache/e2e-local/env.local.
import { createHmac, timingSafeEqual } from "node:crypto";

const b64url = (input) => Buffer.from(input).toString("base64url");

export function signJwt(payload, secret) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

/** The payload of a valid, unexpired HS256 token signed with `secret`, else null. */
export function verifyJwt(token, secret) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  let parsedHeader;
  let payload;
  try {
    parsedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (parsedHeader?.alg !== "HS256") return null;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url"));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
  return payload;
}

/** `node jwt.mjs keys <secret>` prints the anon and service-role keys (10-year tokens, local only). */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && process.argv[2] === "keys") {
  const secret = process.argv[3];
  if (!secret || secret.length < 32) {
    console.error("usage: node jwt.mjs keys <secret of 32+ characters>");
    process.exit(2);
  }
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 10 * 365 * 24 * 3600;
  console.log(`ANON_KEY=${signJwt({ iss: "honest-e2e-local", role: "anon", iat, exp }, secret)}`);
  console.log(`SERVICE_ROLE_KEY=${signJwt({ iss: "honest-e2e-local", role: "service_role", iat, exp }, secret)}`);
}
