import { createServerClient } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";
import { publicEnv } from "@/env";

/**
 * Refreshes the Supabase session inside the proxy and copies refreshed auth
 * cookies (plus the no-cache headers Supabase requires) onto `response`.
 * Returns whether the request carries a valid, verified session.
 */
export async function refreshSession(request: NextRequest, response: NextResponse): Promise<{ authenticated: boolean }> {
  const env = publicEnv();
  const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet, headers) => {
        toSet.forEach(({ name, value, options }) => {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        });
        Object.entries(headers ?? {}).forEach(([key, value]) => response.headers.set(key, value));
      },
    },
  });
  // getClaims() verifies the JWT (unlike getSession(), which trusts the cookie).
  const { data, error } = await supabase.auth.getClaims();
  return { authenticated: !error && Boolean(data?.claims?.sub) };
}
