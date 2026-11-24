// LOCAL TEST HARNESS ONLY (docs/TESTING.md "Local signed-in stack"). Never deploy.
//
// One Node process (built-ins only) on 127.0.0.1:$E2E_GATEWAY_PORT that stands in for the
// Supabase API gateway:
//   /rest/v1/*  → proxied to the local PostgREST ($E2E_POSTGREST_PORT), path prefix stripped
//   /auth/v1/*  → a tiny GoTrue subset, enough for @supabase/ssr and supabase-js as the app uses
//                 them: password sign-in, refresh, getUser (getClaims verifies HS256 tokens with
//                 it), sign-out, the factor list (from the user object), magic-link requests
//                 (accepted, nothing is sent). MFA enrol/verify and the admin API answer 422/501.
//
// Users come from $E2E_USERS_FILE (written by up.sh from the fixture's auth.users), all with the
// one local password $E2E_LOCAL_PASSWORD. Tokens are HS256 with the per-run $E2E_JWT_SECRET and
// carry sub, role "authenticated", aal (aal2 for users marked so: the owner persona) and exp.
import { createServer, request as httpRequest } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { signJwt, verifyJwt } from "./jwt.mjs";

const SECRET = process.env.E2E_JWT_SECRET ?? "";
const PASSWORD = process.env.E2E_LOCAL_PASSWORD ?? "";
const PORT = Number(process.env.E2E_GATEWAY_PORT ?? 54321);
const PGRST_PORT = Number(process.env.E2E_POSTGREST_PORT ?? 54322);
const USERS_FILE = process.env.E2E_USERS_FILE ?? "";
const TOKEN_TTL_S = Number(process.env.E2E_TOKEN_TTL_S ?? 3600);
const ISSUER = `http://127.0.0.1:${PORT}/auth/v1`;

if (SECRET.length < 32 || !PASSWORD || !USERS_FILE) {
  console.error("mock-auth: E2E_JWT_SECRET (32+ chars), E2E_LOCAL_PASSWORD and E2E_USERS_FILE are required");
  process.exit(2);
}

/** @type {{ id: string, email: string, aal: "aal1" | "aal2" }[]} */
const users = JSON.parse(readFileSync(USERS_FILE, "utf8"));
const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
const byId = new Map(users.map((u) => [u.id, u]));
/** refresh token → { userId, sessionId } (in memory: a restart signs everyone out). */
const refreshTokens = new Map();
const CREATED_AT = "2026-10-01T08:00:00.000Z";

function factorsFor(u) {
  // An aal2 persona has one verified TOTP factor, as after enrolment on /account/security.
  return u.aal === "aal2"
    ? [{ id: `f${u.id.slice(1)}`, friendly_name: "Local demo authenticator", factor_type: "totp", status: "verified", created_at: CREATED_AT, updated_at: CREATED_AT }]
    : [];
}

function userObject(u) {
  return {
    id: u.id,
    aud: "authenticated",
    role: "authenticated",
    email: u.email,
    email_confirmed_at: CREATED_AT,
    phone: "",
    confirmed_at: CREATED_AT,
    last_sign_in_at: new Date().toISOString(),
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    identities: [],
    factors: factorsFor(u),
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    is_anonymous: false,
  };
}

function session(u, sessionId = randomUUID()) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TOKEN_TTL_S;
  const access_token = signJwt(
    {
      iss: ISSUER,
      sub: u.id,
      aud: "authenticated",
      role: "authenticated",
      email: u.email,
      aal: u.aal,
      amr: [{ method: "password", timestamp: iat }, ...(u.aal === "aal2" ? [{ method: "totp", timestamp: iat }] : [])],
      session_id: sessionId,
      is_anonymous: false,
      iat,
      exp,
    },
    SECRET,
  );
  const refresh_token = randomBytes(24).toString("base64url");
  refreshTokens.set(refresh_token, { userId: u.id, sessionId });
  return { access_token, token_type: "bearer", expires_in: TOKEN_TTL_S, expires_at: exp, refresh_token, user: userObject(u) };
}

function send(res, status, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...cors() });
  res.end(payload);
}

const authError = (res, status, code, msg) => send(res, status, { code: status, error_code: code, msg });

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, accept-profile, content-profile, prefer, range, x-supabase-api-version",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function bearerUser(req) {
  const header = req.headers.authorization ?? "";
  const claims = verifyJwt(header.replace(/^Bearer\s+/i, ""), SECRET);
  if (!claims?.sub) return null;
  return byId.get(claims.sub) ?? null;
}

async function handleAuth(req, res, path, url) {
  if (req.method === "GET" && (path === "/health" || path === "/settings")) {
    return send(res, 200, path === "/health" ? { name: "honest-e2e-local-auth" } : { external: { email: true }, disable_signup: true, mailer_autoconfirm: false });
  }
  if (req.method === "GET" && path === "/.well-known/jwks.json") return send(res, 200, { keys: [] });

  if (req.method === "POST" && path === "/token") {
    const body = await readJson(req);
    const grant = url.searchParams.get("grant_type");
    if (grant === "password") {
      const u = byEmail.get(String(body.email ?? "").toLowerCase());
      if (!u || body.password !== PASSWORD) return authError(res, 400, "invalid_credentials", "Invalid login credentials");
      return send(res, 200, session(u));
    }
    if (grant === "refresh_token") {
      const entry = refreshTokens.get(String(body.refresh_token ?? ""));
      const u = entry && byId.get(entry.userId);
      if (!u) return authError(res, 400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
      refreshTokens.delete(String(body.refresh_token));
      return send(res, 200, session(u, entry.sessionId));
    }
    return authError(res, 400, "validation_failed", "unsupported grant_type");
  }

  if (path === "/user") {
    const u = bearerUser(req);
    if (!u) return authError(res, 401, "bad_jwt", "invalid JWT");
    if (req.method === "GET") return send(res, 200, userObject(u));
    return authError(res, 422, "not_implemented", "updateUser is not available in the local mock");
  }

  if (req.method === "POST" && path === "/logout") {
    res.writeHead(204, cors());
    return res.end();
  }

  // Magic link / email code: accepted, nothing is sent (same answer as GoTrue for unknown emails).
  if (req.method === "POST" && path === "/otp") return send(res, 200, {});
  if (req.method === "POST" && path === "/verify") return authError(res, 403, "otp_expired", "Email link is invalid or has expired");

  // MFA: listing reads user.factors (above). Challenges are issued; verification and enrolment
  // are not implemented (the aal2 persona is already aal2).
  const challenge = path.match(/^\/factors\/([^/]+)\/challenge$/);
  if (req.method === "POST" && challenge) {
    const u = bearerUser(req);
    if (!u) return authError(res, 401, "bad_jwt", "invalid JWT");
    return send(res, 200, { id: randomUUID(), type: "totp", expires_at: Math.floor(Date.now() / 1000) + 300 });
  }
  if (path.startsWith("/factors")) return authError(res, 422, "mfa_verification_failed", "MFA enrolment and verification are not available in the local mock");

  if (path.startsWith("/admin")) return authError(res, 501, "not_implemented", "The auth admin API is not available in the local mock");
  return authError(res, 404, "not_found", `local mock: no route for ${req.method} /auth/v1${path}`);
}

function proxyRest(req, res, path, url) {
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: PGRST_PORT,
      method: req.method,
      path: `${path || "/"}${url.search}`,
      headers: { ...req.headers, host: `127.0.0.1:${PGRST_PORT}` },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, { ...up.headers, ...cors() });
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => send(res, 502, { message: `local gateway: PostgREST unreachable (${err.code ?? err.message})` }));
  req.pipe(upstream);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors());
      return res.end();
    }
    if (url.pathname.startsWith("/rest/v1")) return proxyRest(req, res, url.pathname.slice("/rest/v1".length), url);
    if (url.pathname.startsWith("/auth/v1")) return await handleAuth(req, res, url.pathname.slice("/auth/v1".length) || "/", url);
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    return send(res, 404, { message: "local gateway: only /rest/v1 and /auth/v1 exist (no Storage, Realtime or Functions)" });
  } catch (err) {
    console.error("mock-auth:", err);
    if (!res.headersSent) send(res, 500, { message: "local gateway error" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock-auth/gateway on http://127.0.0.1:${PORT} (PostgREST :${PGRST_PORT}, ${users.length} users)`);
});
