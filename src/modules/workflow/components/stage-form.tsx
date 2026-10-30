"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { removeStage, setStage } from "../actions";
import { ActionMessage } from "./action-message";
import { ReasonField } from "./reason-field";
import { StageFields, type StageDefaults, type StageOptions } from "./stage-fields";

/** Set (add or change) one stage of a rule. A new stage lets the admin pick its number. */
export function StageForm({
  definitionId,
  ruleId,
  stageNo,
  isNew,
  defaults,
  options,
  locale,
}: {
  definitionId: string;
  ruleId: string;
  stageNo: number;
  isNew: boolean;
  defaults: StageDefaults;
  options: StageOptions;
  locale: string;
}) {
  const t = useTranslations("workflow.stage");
  const [state, formAction, pending] = useActionState(setStage, null);
  const id = useId();

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="definition_id" value={definitionId} />
      <input type="hidden" name="rule_id" value={ruleId} />
      {isNew ? (
        <div className="space-y-1">
          <Label htmlFor={`${id}-no`}>{t("number")}</Label>
          <Input id={`${id}-no`} name="stage_no" type="number" inputMode="numeric" min={1} max={20} required defaultValue={stageNo} dir="ltr" className="sm:w-32" />
        </div>
      ) : (
        <input type="hidden" name="stage_no" value={stageNo} />
      )}
      <StageFields options={options} defaults={defaults} locale={locale} />
      <ReasonField />
      <ActionMessage state={state} success={t("saved")} />
      <Button type="submit" disabled={pending} className="w-full sm:w-auto">
        {isNew ? t("add") : t("save")}
      </Button>
    </form>
  );
}

/** Remove a stage (refused while requests on the rule are pending, and for the last stage). */
export function RemoveStageForm({ definitionId, ruleId, stageNo }: { definitionId: string; ruleId: string; stageNo: number }) {
  const t = useTranslations("workflow.stage");
  const [state, formAction, pending] = useActionState(removeStage, null);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="definition_id" value={definitionId} />
      <input type="hidden" name="rule_id" value={ruleId} />
      <input type="hidden" name="stage_no" value={stageNo} />
      <p className="text-xs text-muted-foreground">{t("removeHint")}</p>
      <ReasonField />
      <ActionMessage state={state} />
      <Button type="submit" variant="destructive" disabled={pending} className="w-full sm:w-auto">
        {t("remove")}
      </Button>
    </form>
  );
}
