import createIntlMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "@/i18n/routing";
import { refreshSession } from "@/lib/supabase/proxy-session";

const intl = createIntlMiddleware(routing);

// Paths reachable without a session (after the locale prefix).
const PUBLIC_PATHS = [/^\/(ar|en)\/login\/?$/, /^\/(ar|en)\/auth\/confirm\/?$/];

/**
 * Runs before every page request (Next.js 16 "proxy", formerly middleware):
 * 1. locale negotiation/prefix (next-intl), 2. Supabase session refresh,
 * 3. redirect unauthenticated users to the login page.
 * Authorization is NOT decided here — RLS and api.* commands do that.
 */
export async function proxy(request: NextRequest) {
  const response = intl(request);
  // next-intl redirected (e.g. "/" → "/ar"); let that happen first.
  if (response.headers.has("location")) return response;

  const { authenticated } = await refreshSession(request, response);
  const { pathname, search } = request.nextUrl;

  if (!authenticated && !PUBLIC_PATHS.some((re) => re.test(pathname))) {
    const locale = pathname.split("/")[1] === "en" ? "en" : "ar";
    const url = new URL(`/${locale}/login`, request.url);
    if (pathname !== `/${locale}` && pathname !== `/${locale}/`) url.searchParams.set("next", pathname + search);
    const redirect = NextResponse.redirect(url);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  }
  return response;
}

export const config = {
  // Skip API routes, Next internals and static files (anything with a dot).
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
