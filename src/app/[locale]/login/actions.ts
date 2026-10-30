"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { publicEnv } from "@/env";
import { log } from "@/lib/log";
import { safeNextPath } from "@/lib/safe-redirect";
import { createClient } from "@/lib/supabase/server";
import { normaliseTotpCode } from "@/modules/security/logic";

export type LoginState = { status: "idle" | "error" | "link_sent" | "code_sent" | "code_error"; email?: string };

const credentials = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
  locale: z.enum(["ar", "en"]),
  next: z.string().optional(),
});

export async function signIn(_prev: LoginState, form: FormData): Promise<LoginState> {
  const parsed = credentials.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { status: "error", email: String(form.get("email") ?? "") };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: parsed.data.email, password: parsed.data.password });
  if (error) {
    // Same message for unknown email and wrong password (no account enumeration).
    log("warn", "auth.login_failed", { reason: error.code ?? error.name });
    return { status: "error", email: parsed.data.email };
  }
  redirect(safeNextPath(parsed.data.next, parsed.data.locale));
}

const magic = z.object({ email: z.email().max(254), locale: z.enum(["ar", "en"]) });

/**
 * One sign-in email for both options: Supabase's "Magic Link" template carries the link
 * ({{ .TokenHash }} → /auth/confirm) and, once the template includes {{ .Token }}, the
 * 8-digit code of the same one-time password.
 */
async function sendSignInEmail(form: FormData, sent: "link_sent" | "code_sent", event: string): Promise<LoginState> {
  const parsed = magic.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { status: "error", email: String(form.get("email") ?? "") };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      shouldCreateUser: false, // admin-invited users only (no public sign-up)
      emailRedirectTo: `${publicEnv().NEXT_PUBLIC_APP_URL}/${parsed.data.locale}/auth/confirm`,
    },
  });
  if (error) log("warn", event, { reason: error.code ?? error.name });
  // Always the same answer, whether or not the email exists (no account enumeration).
  return { status: sent, email: parsed.data.email };
}

export async function sendMagicLink(_prev: LoginState, form: FormData): Promise<LoginState> {
  return sendSignInEmail(form, "link_sent", "auth.magic_link_failed");
}

/**
 * Email sign-in code, for the Android app (D-14 phase 2): a magic link opens the phone's
 * browser, not the app, so the rep types the 8-digit code from the same email instead.
 */
export async function sendLoginCode(_prev: LoginState, form: FormData): Promise<LoginState> {
  return sendSignInEmail(form, "code_sent", "auth.login_code_failed");
}

/**
 * Email codes are 8 digits valid for 10 minutes (supabase/config.toml [auth.email] otp_length /
 * otp_expiry, and the same settings on the hosted projects). 6 digits are still let through so
 * the login keeps working on a project not yet switched; Supabase checks the code itself.
 */
const LOGIN_CODE = /^\d{6,8}$/;

const code = z.object({
  email: z.email().max(254),
  // Digits only; spaces or dashes a rep may type or paste ("1234 5678") are removed and
  // Arabic-Indic digits converted first (same normaliser as the TOTP code).
  token: z.preprocess((v) => (typeof v === "string" ? normaliseTotpCode(v) : v), z.string().regex(LOGIN_CODE)),
  locale: z.enum(["ar", "en"]),
  next: z.string().optional(),
});

/** Checks the email code and signs in; same safe `next` handling as the password and the confirm route. */
export async function verifyLoginCode(_prev: LoginState, form: FormData): Promise<LoginState> {
  const parsed = code.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { status: "code_error", email: String(form.get("email") ?? "") };

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ email: parsed.data.email, token: parsed.data.token, type: "email" });
  if (error) {
    // Same answer for a wrong, expired or unknown code (Supabase rate-limits verification attempts).
    log("warn", "auth.login_code_invalid", { reason: error.code ?? error.name });
    return { status: "code_error", email: parsed.data.email };
  }
  redirect(safeNextPath(parsed.data.next, parsed.data.locale));
}

export async function signOut(locale: string): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect(`/${locale === "en" ? "en" : "ar"}/login`);
}
