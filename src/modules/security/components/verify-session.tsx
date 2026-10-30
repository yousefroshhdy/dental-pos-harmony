"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { StepUpPrompt } from "./step-up-prompt";

/**
 * Raise this session to aal2 ahead of time (e.g. before a batch of admin work), or after a
 * refused action: with `returnTo` (a path already checked by `stepUpReturnPath`) the user
 * goes straight back to the page that showed MFA_REQUIRED.
 */
export function VerifySessionButton({ returnTo }: { returnTo?: string | null }) {
  const t = useTranslations("security.stepUp");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);

  return (
    <div className="space-y-2">
      <Button type="button" className="w-full sm:w-auto" onClick={() => setOpen(true)}>
        {t("verifyNow")}
      </Button>
      {done ? (
        <Alert tone="success" role="status">
          {t("verified")}
        </Alert>
      ) : null}
      <StepUpPrompt
        open={open}
        onCancel={() => setOpen(false)}
        onVerified={() => {
          setOpen(false);
          setDone(true);
          if (returnTo) router.push(returnTo);
          else router.refresh();
        }}
      />
    </div>
  );
}
