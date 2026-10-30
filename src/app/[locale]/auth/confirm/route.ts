import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { log } from "@/lib/log";
import { safeNextPath } from "@/lib/safe-redirect";
import { createClient } from "@/lib/supabase/server";

const ALLOWED_TYPES: EmailOtpType[] = ["email", "magiclink", "invite", "recovery"];

/**
 * Magic-link / invite landing. The Supabase email templates must point here:
 *   {{ .SiteURL }}/ar/auth/confirm?token_hash={{ .TokenHash }}&type=email
 * (docs/runbooks/supabase-setup.md). The "Magic Link" template also shows {{ .Token }},
 * the 6-digit code that the Android app's login uses instead (login/actions.ts verifyLoginCode).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const url = request.nextUrl;
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;

  if (tokenHash && type && ALLOWED_TYPES.includes(type)) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(safeNextPath(url.searchParams.get("next"), locale), request.url));
    log("warn", "auth.confirm_failed", { reason: error.code ?? error.name, type });
  }
  return NextResponse.redirect(new URL(`/${locale === "en" ? "en" : "ar"}/login`, request.url));
}
