"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { removeFactor } from "../actions";
import type { SecurityResult } from "../types";
import { useStepUpAction } from "./use-step-up-action";

/**
 * Removes one factor. Supabase requires an aal2 session to remove a verified
 * factor, so this is also the in-module example of `useStepUpAction`.
 */
export function RemoveFactorButton({ factorId }: { factorId: string }) {
  const t = useTranslations("security.factors");
  const te = useTranslations("security.errors");
  const { state, formAction, pending, prompt, awaitingStepUp } = useStepUpAction<SecurityResult | null>(removeFactor, null);

  return (
    <div className="space-y-2">
      <form
        action={formAction}
        onSubmit={(event) => {
          if (!window.confirm(t("removeConfirm"))) event.preventDefault();
        }}
      >
        <input type="hidden" name="factor_id" value={factorId} />
        <Button type="submit" variant="outline" disabled={pending}>
          {t("remove")}
        </Button>
      </form>
      {state && !state.ok && !awaitingStepUp ? <Alert>{te(state.messageKey)}</Alert> : null}
      {state?.ok ? (
        <Alert tone="success" role="status">
          {t("removed")}
        </Alert>
      ) : null}
      {prompt}
    </div>
  );
}
