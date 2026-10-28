import "server-only";
import { createClient } from "@supabase/supabase-js";
import { publicEnv, serverEnv } from "@/env";

/**
 * SERVICE-ROLE client — bypasses RLS. Allowed uses only (CLAUDE.md rule 12):
 *   • Auth admin API (inviting users), • outbox dispatcher, • webhook ingestion, • cron jobs.
 * Never import this from a component or pass its results to the client unfiltered.
 * It talks to the `service` schema, which only service_role can use.
 */
export function createServiceClient() {
  const { NEXT_PUBLIC_SUPABASE_URL } = publicEnv();
  const { SUPABASE_SERVICE_ROLE_KEY } = serverEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    db: { schema: "service" },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
