"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { saveRule } from "../actions";
import type { ClauseInput } from "../logic";
import { ActionMessage } from "./action-message";
import { ConditionFields } from "./condition-fields";
import { ReasonField } from "./reason-field";
import { EMPTY_STAGE, StageFields, type StageOptions } from "./stage-fields";

/**
 * Create a rule (priority, condition, first stage) or edit an existing rule
 * (priority, condition, auto-approve). Only owners see the auto-approve switch;
 * the database refuses it for anyone else (OWNER_ONLY).
 */
export function RuleForm({
  definitionId,
  definitionCode,
  ruleId,
  priority,
  autoApprove,
  rows,
  isOwner,
  options,
  locale,
}: {
  definitionId: string;
  definitionCode: string;
  ruleId?: string;
  priority?: number;
  autoApprove?: boolean;
  rows: ClauseInput[];
  isOwner: boolean;
  options: StageOptions;
  locale: string;
}) {
  const t = useTranslations("workflow.rule");
  const [state, formAction, pending] = useActionState(saveRule, null);
  const id = useId();
  const isNew = !ruleId;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="definition_id" value={definitionId} />
      <input type="hidden" name="definition_code" value={definitionCode} />
      {ruleId ? <input type="hidden" name="rule_id" value={ruleId} /> : null}
      <div className="space-y-1">
        <Label htmlFor={`${id}-priority`}>{t("priority")}</Label>
        <Input
          id={`${id}-priority`}
          name="priority"
          type="number"
          inputMode="numeric"
          min={1}
          max={9999}
          required
          defaultValue={priority ?? ""}
          dir="ltr"
          className="sm:w-40"
        />
        <p className="text-xs text-muted-foreground">{t("priorityHint")}</p>
      </div>
      <ConditionFields rows={rows} />
      {isOwner ? (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="auto_approve" defaultChecked={autoApprove ?? false} className="size-5" />
          {t("autoApprove")}
        </label>
      ) : autoApprove ? (
        // Keeps an owner's auto-approve rule as it is when an admin edits its condition.
        <input type="hidden" name="auto_approve" value="on" />
      ) : null}
      {isNew ? (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t("firstStage")}</legend>
          <p className="text-xs text-muted-foreground">{t("firstStageHint")}</p>
          <StageFields options={options} defaults={EMPTY_STAGE} locale={locale} />
        </fieldset>
      ) : null}
      <ReasonField />
      <ActionMessage state={state} success={isNew ? t("created") : t("saved")} />
      <Button type="submit" disabled={pending} className="w-full sm:w-auto">
        {isNew ? t("create") : t("save")}
      </Button>
    </form>
  );
}
