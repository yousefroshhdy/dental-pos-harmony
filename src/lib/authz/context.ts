import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { log } from "@/lib/log";
import { ANONYMOUS_CONTEXT, type UserContext } from "./can";

/**
 * The signed-in user's context from `api.my_context()`, cached per request.
 * Used for navigation and UI gating only; Postgres enforces the real rules.
 */
export const getUserContext = cache(async (): Promise<UserContext> => {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return ANONYMOUS_CONTEXT;

  const { data, error } = await supabase.rpc("my_context");
  if (error || !data) {
    log("error", "authz.context_failed", { code: error?.code, detail: error?.message });
    return { ...ANONYMOUS_CONTEXT, user_id: claims.claims.sub };
  }
  return data as UserContext;
});
