"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/primitives";
import { decideApproval } from "../actions";
import { COMMENT_MAX } from "../schemas";
import { ActionMessage } from "./action-message";

/**
 * Approve / reject with a comment. The clicked button's value is the decision.
 * The hidden request id only identifies the record; api.decide_approval decides
 * whether the signed-in user may act on it. Works without JS.
 */
export function DecisionForm({ requestId }: { requestId: string }) {
  const t = useTranslations("approvals.decide");
  const [state, formAction, pending] = useActionState(decideApproval, null);
  const commentId = useId();
  const hintId = useId();

  const success =
    state?.ok && state.status === "pending" && state.currentStage
      ? t("movedToStage", { stage: state.currentStage })
      : state?.ok && state.status === "approved"
        ? t("approvedDone")
        : state?.ok && state.status === "rejected"
          ? t("rejectedDone")
          : undefined;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="request_id" value={requestId} />
      <div className="space-y-1">
        <Label htmlFor={commentId}>{t("comment")}</Label>
        <textarea
          id={commentId}
          name="comment"
          rows={3}
          maxLength={COMMENT_MAX}
          aria-describedby={hintId}
          aria-invalid={state && !state.ok && state.messageKey === "COMMENT_REQUIRED" ? true : undefined}
          placeholder={t("commentPlaceholder")}
          className="flex min-h-24 w-full rounded-md border bg-card px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          {t("commentHint")}
        </p>
      </div>
      <ActionMessage state={state} success={success} />
      {/* Primary actions stay reachable at the bottom of the screen on phones. */}
      <div className="sticky bottom-0 -mx-4 flex gap-2 border-t bg-card px-4 py-3 sm:static sm:mx-0 sm:border-0 sm:px-0 sm:py-0">
        <Button type="submit" name="decision" value="approve" disabled={pending} className="flex-1 sm:flex-none">
          {t("approve")}
        </Button>
        <Button type="submit" name="decision" value="reject" variant="destructive" disabled={pending} className="flex-1 sm:flex-none">
          {t("reject")}
        </Button>
      </div>
    </form>
  );
}
