import "server-only";
import type { Factor } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { log } from "@/lib/log";
import { getRequestId } from "@/lib/request-id";
import { authErrorKey } from "./logic";
import type { FactorRow, MfaStatus, SecurityErrorKey } from "./types";

/**
 * Reads for the account security page, as the signed-in user. Factors come from
 * Supabase Auth; the policy (switch, session aal, gated permissions) from Postgres.
 */

type Read<T> = { ok: true; data: T } | { ok: false; messageKey: SecurityErrorKey };

export function toFactorRow(f: Pick<Factor, "id" | "friendly_name" | "status" | "created_at">): FactorRow {
  return { id: f.id, friendly_name: f.friendly_name ?? null, status: f.status, created_at: f.created_at };
}

/** The user's TOTP factors (verified and abandoned unverified ones). */
export async function listTotpFactors(): Promise<Read<FactorRow[]>> {
  const supabase = await createClient();
  try {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) {
      log("warn", "security.factors_failed", { requestId: await getRequestId(), code: error.code, detail: error.message });
      return { ok: false, messageKey: authErrorKey(error) };
    }
    return { ok: true, data: data.all.filter((f) => f.factor_type === "totp").map(toFactorRow) };
  } catch (cause) {
    log("error", "security.factors_failed", { requestId: await getRequestId(), detail: cause instanceof Error ? cause.message : "unknown" });
    return { ok: false, messageKey: "UNAVAILABLE" };
  }
}

/** `api.my_mfa_status()`: is enforcement on, this session's aal, and my gated permissions. */
export async function getMfaStatus(): Promise<Read<MfaStatus>> {
  const supabase = await createClient();
  try {
    const { data, error } = await supabase.rpc("my_mfa_status");
    if (error || !data) {
      log("warn", "security.status_failed", { requestId: await getRequestId(), code: error?.code, detail: error?.message });
      return { ok: false, messageKey: "UNAVAILABLE" };
    }
    const s = data as Partial<MfaStatus>;
    return {
      ok: true,
      data: {
        enforced: s.enforced === true,
        aal: typeof s.aal === "string" ? s.aal : null,
        required_permissions: Array.isArray(s.required_permissions) ? s.required_permissions : [],
      },
    };
  } catch (cause) {
    log("error", "security.status_failed", { requestId: await getRequestId(), detail: cause instanceof Error ? cause.message : "unknown" });
    return { ok: false, messageKey: "UNAVAILABLE" };
  }
}
