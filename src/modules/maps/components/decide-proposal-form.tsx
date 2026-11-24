"use client";

import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Label } from "@/components/ui/primitives";
import { decideLocationProposal } from "../actions";
import type { MapsActionState } from "../types";
import { MapsActionMessage } from "./action-message";

/**
 * Approve (the fix becomes the verified clinic pin) or reject (with a reason) one proposal.
 * The database decides whether the user may (crm.customer_location.verify, customer scope).
 */
export function DecideProposalForm({ proposalId, inaccurate }: { proposalId: string; inaccurate: boolean }) {
  const t = useTranslations("maps.proposals");
  const [state, action, pending] = useActionState<MapsActionState, FormData>(decideLocationProposal, null);
  const [rejecting, setRejecting] = useState(false);

  if (state?.ok) return <Alert tone="success" role="status">{t("decided")}</Alert>;

  return (
    <div className="space-y-2">
      {inaccurate ? <p className="text-sm text-muted-foreground">{t("inaccurateHint")}</p> : null}
      {rejecting ? (
        <form action={action} className="space-y-2">
          <input type="hidden" name="proposal_id" value={proposalId} />
          <input type="hidden" name="decision" value="reject" />
          <Label htmlFor={`note-${proposalId}`}>{t("reason")}</Label>
          <textarea
            id={`note-${proposalId}`}
            name="note"
            required
            maxLength={500}
            rows={2}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" disabled={pending}>
              {t("confirmReject")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setRejecting(false)} disabled={pending}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <form action={action}>
            <input type="hidden" name="proposal_id" value={proposalId} />
            <input type="hidden" name="decision" value="approve" />
            <Button type="submit" disabled={pending || inaccurate}>
              {t("approve")}
            </Button>
          </form>
          <Button type="button" variant="outline" onClick={() => setRejecting(true)} disabled={pending}>
            {t("reject")}
          </Button>
        </div>
      )}
      <MapsActionMessage state={state} />
    </div>
  );
}
