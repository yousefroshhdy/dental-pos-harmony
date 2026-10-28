import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { publicEnv } from "@/env";

/**
 * Supabase client acting AS THE SIGNED-IN USER (anon key + session cookie).
 * RLS and authz.* checks apply to every call. This is the default client for
 * Server Components, Server Actions and Route Handlers.
 *
 * Only the `api` schema is exposed by PostgREST (ADR-005).
 */
export async function createClient() {
  const cookieStore = await cookies();
  const env = publicEnv();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    db: { schema: "api" },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // proxy (src/proxy.ts) refreshes the session on every request.
        }
      },
    },
  });
}
