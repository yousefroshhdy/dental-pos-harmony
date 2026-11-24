import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { log } from "@/lib/log";
import { ANONYMOUS_CONTEXT, type UserContext } from "./can";

/**
 * The context the shell renders from. `error` is true when the user IS signed in
 * but `api.my_context()` failed (network, timeout, a database error): the context
 * then grants nothing (active false, no permissions), exactly as before, but the
 * shell can tell "couldn't load your account" apart from "account not active".
 */
export type LoadedUserContext = UserContext & { error: boolean };

/**
 * The signed-in user's context from `api.my_context()`, cached per request.
 * Used for navigation and UI gating only; Postgres enforces the real rules.
 */
export const getUserContext = cache(async (): Promise<LoadedUserContext> => {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return { ...ANONYMOUS_CONTEXT, error: false };

  try {
    const { data, error } = await supabase.rpc("my_context");
    if (error || !data) {
      log("error", "authz.context_failed", { code: error?.code, detail: error?.message });
      return { ...ANONYMOUS_CONTEXT, user_id: claims.claims.sub, error: true };
    }
    return { ...(data as UserContext), error: false };
  } catch (cause) {
    // A thrown fetch error (offline server, DNS) is the same "could not load" case.
    log("error", "authz.context_failed", { detail: cause instanceof Error ? cause.message : String(cause) });
    return { ...ANONYMOUS_CONTEXT, user_id: claims.claims.sub, error: true };
  }
});
