import { beforeEach, describe, expect, it, vi } from "vitest";

// The sign-in email code (Android app, D-14 phase 2). Supabase and Next.js are faked.
type AuthAnswer = { error: null | { code?: string; name: string } };
const auth = {
  signInWithOtp: vi.fn<(args: unknown) => Promise<AuthAnswer>>(async () => ({ error: null })),
  verifyOtp: vi.fn<(args: unknown) => Promise<AuthAnswer>>(async () => ({ error: null })),
};
const redirects: string[] = [];

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth }) }));
vi.mock("@/env", () => ({ publicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://app.example.test" }) }));
vi.mock("@/lib/log", () => ({ log: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    redirects.push(to);
    throw new Error("NEXT_REDIRECT");
  },
}));

import { sendLoginCode, sendMagicLink, verifyLoginCode, type LoginState } from "@/app/[locale]/login/actions";

// Synthetic address only (D-03).
const EMAIL = "rep.sample@example.test";
const idle: LoginState = { status: "idle" };

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  auth.signInWithOtp.mockClear();
  auth.verifyOtp.mockClear();
  auth.verifyOtp.mockImplementation(async () => ({ error: null }));
  auth.signInWithOtp.mockImplementation(async () => ({ error: null }));
  redirects.length = 0;
});

describe("sending the code", () => {
  it("asks Supabase for the same sign-in email as the magic link (no sign-up), and asks for the code", async () => {
    expect(await sendLoginCode(idle, form({ email: EMAIL, locale: "ar" }))).toEqual({ status: "code_sent", email: EMAIL });
    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: EMAIL,
      options: { shouldCreateUser: false, emailRedirectTo: "https://app.example.test/ar/auth/confirm" },
    });
  });
  it("answers the same whether or not the email exists", async () => {
    auth.signInWithOtp.mockImplementation(async () => ({ error: { code: "otp_disabled", name: "AuthApiError" } }));
    expect(await sendLoginCode(idle, form({ email: EMAIL, locale: "en" }))).toEqual({ status: "code_sent", email: EMAIL });
  });
  it("refuses a malformed email without calling Supabase", async () => {
    expect(await sendLoginCode(idle, form({ email: "not-an-email", locale: "ar" }))).toEqual({ status: "error", email: "not-an-email" });
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });
  it("the magic link still works as before", async () => {
    expect(await sendMagicLink(idle, form({ email: EMAIL, locale: "en" }))).toEqual({ status: "link_sent", email: EMAIL });
    expect(auth.signInWithOtp).toHaveBeenCalledTimes(1);
  });
});

describe("verifying the code", () => {
  it("verifies an email OTP and redirects to a safe next path", async () => {
    await expect(verifyLoginCode(idle, form({ email: EMAIL, token: "123 456", locale: "en", next: "/en/today" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(auth.verifyOtp).toHaveBeenCalledWith({ email: EMAIL, token: "123456", type: "email" });
    expect(redirects).toEqual(["/en/today"]);
  });
  it("never follows an unsafe next (same rule as the password and the confirm route)", async () => {
    await expect(verifyLoginCode(idle, form({ email: EMAIL, token: "123456", locale: "ar", next: "//evil.example" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(redirects).toEqual(["/ar"]);
  });
  it("a wrong or expired code is one answer, and the email is kept", async () => {
    auth.verifyOtp.mockImplementation(async () => ({ error: { code: "otp_expired", name: "AuthApiError" } }));
    expect(await verifyLoginCode(idle, form({ email: EMAIL, token: "000000", locale: "ar" }))).toEqual({ status: "code_error", email: EMAIL });
    expect(redirects).toEqual([]);
  });
  it.each(["12345", "1234567", "12a456", ""])("refuses %j without calling Supabase", async (token) => {
    expect(await verifyLoginCode(idle, form({ email: EMAIL, token, locale: "ar" }))).toEqual({ status: "code_error", email: EMAIL });
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });
});
