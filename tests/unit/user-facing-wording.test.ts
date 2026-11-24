import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANONYMOUS_CONTEXT, type UserContext } from "@/lib/authz/can";
import { seesSetupDetails } from "@/lib/maps/config";

/**
 * Plain language on screens (docs/DECISIONS.md Part C, Phase P review item 3): reps, managers,
 * finance and inventory read business words, never developer words. Technical detail (an
 * environment variable, which Google API to enable) is allowed only in strings that render on
 * owner/admin screens or only for the owner/admin; those keys are listed below, each with why.
 */

const root = join(__dirname, "../../messages");

/** Every string of a locale, keyed `namespace.path` exactly as `t()` reads it. */
function messages(locale: "ar" | "en"): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: unknown, prefix: string) => {
    if (typeof node === "string") out.set(prefix, node);
    else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, prefix ? `${prefix}.${k}` : k);
  };
  walk(JSON.parse(readFileSync(join(root, `${locale}.json`), "utf8")), "");
  for (const file of readdirSync(join(root, locale)).filter((f) => f.endsWith(".json"))) {
    walk(JSON.parse(readFileSync(join(root, locale, file), "utf8")), file.replace(/\.json$/, ""));
  }
  return out;
}

/** Developer words. Word boundaries keep "Key account" and the like matchable but explicit. */
const DEVELOPER_WORDS: { name: string; re: RegExp }[] = [
  { name: "server", re: /\bservers?\b/i },
  { name: "server (ar)", re: /الخادم|خادم|سيرفر/ },
  { name: "API", re: /\bAPIs?\b/ },
  { name: "key", re: /\bkeys?\b/i },
  { name: "key (ar)", re: /مفتاح|مفاتيح/ },
  { name: "env var", re: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|SECRET|URL|ID|TOKEN)\b/ },
  { name: "HTTP status", re: /\b(?:HTTP\s*)?(?:400|401|403|404|405|409|410|422|429|500|502|503|504)\b/ },
  { name: "RPC", re: /\bRPC\b/ },
  { name: "PostgREST", re: /postgrest/i },
  { name: "Supabase", re: /supabase/i },
  { name: "SMTP", re: /\bSMTP\b/ },
  { name: "JSON", re: /\bJSON\b/ },
  { name: "UUID", re: /\bUUID\b/i },
  { name: "SQL", re: /\bSQL(?:STATE)?\b|\b(?:SELECT\s+\*|INSERT\s+INTO|DELETE\s+FROM)\b/ },
  { name: "idempotency", re: /idempoten/i },
  { name: "payload", re: /\bpayload\b/i },
  { name: "null", re: /\bnull\b/i },
  {
    name: "permission code",
    re: /\b(?:core|authz|catalog|inventory|crm|field|work|sales|finance|perf|wf|audit|notify|integration|admin|api|service)\.[a-z_]+(?:\.[a-z_]+)*\b/,
  },
];

/**
 * Keys allowed to carry a developer word (in either locale), with the reason. Keep it short:
 * a new entry needs a screen only the owner/admin sees, or a word that is the user's own word.
 */
const ALLOWED: Record<string, string> = {
  "admin.errors.SETTING_SECRET_REFUSED": "Admin settings only; tells the admin an API key never goes in settings.",
  "admin.employeeDetail.roles.key_account": "Business word: a key-account rep, not an API key.",
  "approvals.inboxTable.keyFact": "Business word: the key detail of a request, not an API key.",
  "security.enrol.secretLabel": "Authenticator apps call it a setup key; it is the word the user types it under.",
  "setup.base.problems.not_configured": "Owner-only /admin/setup: names the env var the owner sets for address search.",
  "setup.login.smtpNote": "Owner-only /admin/setup: where e-mail invites are switched on (SMTP in Supabase).",
  "setup.login.linkWarning": "Owner-only /admin/setup: the sign-in link lifetime is a Supabase project setting.",
  "legacyImport.intro": "Owner-only /admin/setup/legacy-import: says the workbook is converted in server memory, never stored.",
  "maps.map.noKeySetupHint": "Rendered only for the owner/admin (setupHint): which env var to set.",
  "maps.map.rejectedSetupHint": "Rendered only for the owner/admin (setupHint): what to check in Google Cloud.",
  "leads.list.notConfiguredSetupHint": "Rendered only for the owner/admin (setupHint): which env var to set.",
};

function hits(locale: "ar" | "en") {
  const found: string[] = [];
  for (const [key, value] of messages(locale)) {
    if (key in ALLOWED) continue;
    for (const { name, re } of DEVELOPER_WORDS) if (re.test(value)) found.push(`${locale} ${key} [${name}]: ${value}`);
  }
  return found;
}

describe("user-facing wording: no developer language on screens", () => {
  it.each(["ar", "en"] as const)("%s strings carry no developer words outside the allow-list", (locale) => {
    expect(hits(locale)).toEqual([]);
  });

  it("every allow-listed key exists in both locales and gives a reason", () => {
    const ar = messages("ar");
    const en = messages("en");
    for (const [key, reason] of Object.entries(ALLOWED)) {
      expect(ar.has(key) && en.has(key), key).toBe(true);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it("the reviewer's examples read as plain language", () => {
    const ar = messages("ar");
    const en = messages("en");
    expect(ar.get("orders.builder.intro")).not.toMatch(/الخادم/);
    expect(ar.get("orders.builder.preview")).not.toMatch(/الخادم/);
    expect(en.get("leads.list.notConfigured")).toBe("Clinic names are not available yet. Ask the owner to finish the Google Maps setup.");
    expect(ar.get("leads.list.notConfigured")).toBe("أسماء العيادات غير متاحة بعد. اطلب من المالك إكمال إعداد خرائط Google.");
  });

  it("the patterns catch what they are for", () => {
    const flagged = (s: string) => DEVELOPER_WORDS.filter(({ re }) => re.test(s)).map((w) => w.name);
    expect(flagged("يحسب الخادم الأسعار عند الحفظ")).toContain("server (ar)");
    expect(flagged("The owner adds GOOGLE_MAPS_SERVER_KEY.")).toContain("env var");
    expect(flagged("Google answered 403")).toContain("HTTP status");
    expect(flagged("needs crm.lead.read")).toContain("permission code");
    expect(flagged("Prices are worked out when you save, e.g. 250.00 EGP within 150 m.")).toEqual([]);
  });
});

describe("who reads the technical setup detail (display choice, not security)", () => {
  const ctx = (patch: Partial<UserContext>): UserContext => ({ ...ANONYMOUS_CONTEXT, active: true, status: "active", ...patch });

  it("the owner and admin.settings.manage holders do; reps, managers and finance do not", () => {
    expect(seesSetupDetails(ctx({ is_owner: true }))).toBe(true);
    expect(seesSetupDetails(ctx({ permissions: { "admin.settings.manage": { scope: "all", limit: null } } }))).toBe(true);
    expect(seesSetupDetails(ctx({ permissions: { "crm.lead.read": { scope: "own", limit: null } } }))).toBe(false);
    expect(seesSetupDetails(ctx({ permissions: { "crm.lead.assign": { scope: "team", limit: null }, "finance.invoice.issue": { scope: "all", limit: null } } }))).toBe(false);
    expect(seesSetupDetails(ANONYMOUS_CONTEXT)).toBe(false);
  });
});
