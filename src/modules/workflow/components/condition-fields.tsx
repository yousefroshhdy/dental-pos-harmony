"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { Input, Label, Select } from "@/components/ui/primitives";
import type { ClauseInput } from "../logic";
import { CONDITION_OPS, VALUE_TYPES } from "../types";

/**
 * Condition editor: a fixed number of clause rows (empty rows are ignored), all
 * of which must hold. The result is DATA in the {"all":[{field,op,value}]}
 * format; the database validates it again (api.upsert_workflow_rule).
 */
export function ConditionFields({ rows }: { rows: ClauseInput[] }) {
  const t = useTranslations("workflow.condition");
  const tType = useTranslations("workflow.valueType");
  const id = useId();

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">{t("legend")}</legend>
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
      <ol className="space-y-3">
        {rows.map((row, i) => (
          <li key={i} className="grid gap-2 rounded-md border p-3 sm:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor={`${id}-${i}-field`} className="text-xs text-muted-foreground">
                {t("field")}
              </Label>
              <Input
                id={`${id}-${i}-field`}
                name={`clause_${i}_field`}
                defaultValue={row.field}
                placeholder={t("fieldPlaceholder")}
                autoComplete="off"
                dir="ltr"
                maxLength={120}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-${i}-op`} className="text-xs text-muted-foreground">
                {t("op")}
              </Label>
              <Select id={`${id}-${i}-op`} name={`clause_${i}_op`} defaultValue={row.op} className="w-full" dir="ltr">
                {CONDITION_OPS.map((op) => (
                  <option key={op} value={op}>
                    {op === "in" ? t("opIn") : op}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-${i}-type`} className="text-xs text-muted-foreground">
                {t("type")}
              </Label>
              <Select id={`${id}-${i}-type`} name={`clause_${i}_type`} defaultValue={row.type} className="w-full">
                {VALUE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {tType(type)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-${i}-value`} className="text-xs text-muted-foreground">
                {t("value")}
              </Label>
              <Input
                id={`${id}-${i}-value`}
                name={`clause_${i}_value`}
                defaultValue={row.value}
                placeholder={t("valuePlaceholder")}
                autoComplete="off"
                dir="ltr"
                maxLength={2000}
              />
            </div>
          </li>
        ))}
      </ol>
    </fieldset>
  );
}
