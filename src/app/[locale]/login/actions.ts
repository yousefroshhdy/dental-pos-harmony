"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { publicEnv } from "@/env";
import { log } from "@/lib/log";
import { safeNextPath } from "@/lib/safe-redirect";
import { createClient } from "@/lib/supabase/server";

export type LoginState = { status: "idle" | "error" | "link_sent"; email?: string };

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

export async function sendMagicLink(_prev: LoginState, form: FormData): Promise<LoginState> {
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
  if (error) log("warn", "auth.magic_link_failed", { reason: error.code ?? error.name });
  // Always the same answer, whether or not the email exists.
  return { status: "link_sent", email: parsed.data.email };
}

export async function signOut(locale: string): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect(`/${locale === "en" ? "en" : "ar"}/login`);
}
