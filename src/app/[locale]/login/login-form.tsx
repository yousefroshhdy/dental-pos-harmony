"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { sendMagicLink, signIn, type LoginState } from "./actions";

const initial: LoginState = { status: "idle" };

export function LoginForm({ locale, next }: { locale: string; next?: string }) {
  const t = useTranslations("auth");
  const [state, loginAction, loggingIn] = useActionState(signIn, initial);
  const [linkState, linkAction, sendingLink] = useActionState(sendMagicLink, initial);

  return (
    <form action={loginAction} className="space-y-4" noValidate>
      <input type="hidden" name="locale" value={locale} />
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {state.status === "error" ? <Alert>{t("invalid")}</Alert> : null}
      {linkState.status === "link_sent" ? <Alert tone="info">{t("magicLinkSent")}</Alert> : null}

      <div className="space-y-2">
        <Label htmlFor="email">{t("email")}</Label>
        <Input id="email" name="email" type="email" inputMode="email" autoComplete="username" dir="ltr" required defaultValue={state.email ?? linkState.email} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">{t("password")}</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" dir="ltr" />
      </div>

      <Button type="submit" className="w-full" disabled={loggingIn}>
        {t("submit")}
      </Button>
      <Button type="submit" variant="link" className="w-full" formAction={linkAction} formNoValidate disabled={sendingLink}>
        {t("magicLink")}
      </Button>
    </form>
  );
}
