"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { sendLoginCode, sendMagicLink, signIn, verifyLoginCode, type LoginState } from "./actions";

const initial: LoginState = { status: "idle" };

/**
 * Password, magic link, or a 6-digit email code. The code exists for the Android app
 * (D-14 phase 2): a magic link opens the phone's browser, so the session would land
 * there instead of in the app. One form, so the single hidden `next` field serves all.
 */
export function LoginForm({ locale, next }: { locale: string; next?: string }) {
  const t = useTranslations("auth");
  const [state, loginAction, loggingIn] = useActionState(signIn, initial);
  const [linkState, linkAction, sendingLink] = useActionState(sendMagicLink, initial);
  const [codeState, codeAction, sendingCode] = useActionState(sendLoginCode, initial);
  const [verifyState, verifyAction, verifying] = useActionState(verifyLoginCode, initial);

  const codeAsked = codeState.status === "code_sent" || verifyState.status === "code_error";
  const email = verifyState.email ?? codeState.email ?? state.email ?? linkState.email;

  return (
    <form action={loginAction} className="space-y-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {state.status === "error" ? <Alert>{t("invalid")}</Alert> : null}
      {linkState.status === "link_sent" ? <Alert tone="info">{t("magicLinkSent")}</Alert> : null}

      <div className="space-y-2">
        <Label htmlFor="email">{t("email")}</Label>
        <Input id="email" name="email" type="email" inputMode="email" autoComplete="username" dir="ltr" required defaultValue={email} />
      </div>

      {codeAsked ? (
        <div className="space-y-2 rounded-md border p-3">
          {verifyState.status === "code_error" ? <Alert>{t("otpInvalid")}</Alert> : <Alert tone="info">{t("otpSent")}</Alert>}
          <Label htmlFor="otp">{t("otpCode")}</Label>
          <Input
            id="otp"
            name="token"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={7}
            dir="ltr"
            className="tracking-widest"
            aria-describedby="otp-hint"
            autoFocus
          />
          <p id="otp-hint" className="text-xs text-muted-foreground">
            {t("otpHint")}
          </p>
          <Button type="submit" className="w-full" formAction={verifyAction} formNoValidate disabled={verifying}>
            {t("otpVerify")}
          </Button>
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="password">{t("password")}</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" dir="ltr" />
      </div>

      <Button type="submit" className="w-full" variant={codeAsked ? "outline" : "default"} disabled={loggingIn}>
        {t("submit")}
      </Button>
      <Button type="submit" variant="link" className="w-full" formAction={codeAction} formNoValidate disabled={sendingCode}>
        {t("otpSend")}
      </Button>
      <Button type="submit" variant="link" className="w-full" formAction={linkAction} formNoValidate disabled={sendingLink}>
        {t("magicLink")}
      </Button>
    </form>
  );
}
