"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { requestAdjustment } from "../actions";
import { REASON_CODES, shortId, toQuery } from "../logic";
import type { AdjustmentState } from "../types";
import { InventoryError, useKeepValuesAction } from "./inventory-error";
import type { StockLineChoice } from "./transfer-form";

export interface AdjustmentLineChoice extends StockLineChoice {
  onHand: number;
}

/**
 * Stock adjustment request. Within the user's cumulative daily limit (per
 * product and warehouse, Cairo day) the database posts it at once; above it,
 * an approval request is raised and stock only changes when it is approved.
 * The idempotency key survives failures, so retrying the same submission can
 * never post twice; a fresh key is issued after each completed request.
 */
export function AdjustmentForm({
  locale,
  warehouseId,
  lines,
  defaultLine,
  initialKey,
}: {
  locale: string;
  warehouseId: string;
  lines: AdjustmentLineChoice[];
  defaultLine?: string;
  initialKey: string;
}) {
  const t = useTranslations("inventory.adjustmentForm");
  const [state, onSubmit, pending] = useKeepValuesAction<AdjustmentState>(requestAdjustment, null);
  const key = state ? (state.ok ? state.nextKey : state.idempotencyKey) : initialKey;
  const [lastLine, setLastLine] = useState(defaultLine ?? "");

  return (
    <form onSubmit={onSubmit} className="space-y-6" aria-busy={pending}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="warehouse_id" value={warehouseId} />
      <input type="hidden" name="idempotency_key" value={key} />

      {state?.ok ? <Outcome state={state} warehouseId={warehouseId} /> : null}

      {/* The key changes only after a completed request, so the fields clear then and are kept after a failure. */}
      <Fields key={key} lines={lines} defaultLine={lastLine} onLineChange={setLastLine} />

      {state && !state.ok ? <InventoryError code={state.code} messageKey={state.messageKey} requestId={state.requestId} /> : null}

      <div className="sticky bottom-0 -mx-4 border-t bg-card/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
        <Button type="submit" disabled={pending || lines.length === 0} className="w-full sm:w-auto">
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

function Fields({
  lines,
  defaultLine,
  onLineChange,
}: {
  lines: AdjustmentLineChoice[];
  defaultLine: string;
  onLineChange: (v: string) => void;
}) {
  const t = useTranslations("inventory.adjustmentForm");
  const tReasons = useTranslations("inventory.reasons");
  const [line, setLine] = useState(lines.some((l) => l.value === defaultLine) ? defaultLine : "");
  const [direction, setDirection] = useState<"in" | "out">("out");
  const [reason, setReason] = useState<string>("");
  const chosen = lines.find((l) => l.value === line);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="adj-line">{t("lot")}</Label>
        <Select
          id="adj-line"
          name="line"
          required
          value={line}
          onChange={(e) => {
            setLine(e.target.value);
            onLineChange(e.target.value);
          }}
          className="w-full"
        >
          <option value="" disabled>
            {t("selectLot")}
          </option>
          {lines.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </Select>
        {chosen ? (
          <p className="text-xs text-muted-foreground">{t("lotState", { onHand: chosen.onHand, available: chosen.available })}</p>
        ) : null}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("direction")}</legend>
        <div className="flex gap-2">
          {(["out", "in"] as const).map((d) => (
            <label
              key={d}
              className="flex min-h-11 flex-1 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10"
            >
              <input type="radio" name="direction" value={d} checked={direction === d} onChange={() => setDirection(d)} />
              {t(d === "out" ? "remove" : "add")}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="adj-qty">{t("quantity")}</Label>
        <Input
          id="adj-qty"
          name="quantity"
          type="number"
          inputMode="numeric"
          min={1}
          max={direction === "out" && chosen ? Math.max(chosen.available, 1) : 1000000}
          step={1}
          required
          dir="ltr"
          defaultValue=""
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="adj-reason">{t("reason")}</Label>
        <Select id="adj-reason" name="reason_code" required value={reason} onChange={(e) => setReason(e.target.value)} className="w-full">
          <option value="" disabled>
            {t("selectReason")}
          </option>
          {REASON_CODES.map((code) => (
            <option key={code} value={code}>
              {tReasons(code)}
            </option>
          ))}
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="adj-note">
          {t("note")} {reason === "other" ? null : <span className="text-muted-foreground">({t("optional")})</span>}
        </Label>
        <Input
          id="adj-note"
          name="note"
          maxLength={300}
          required={reason === "other"}
          minLength={reason === "other" ? 3 : undefined}
          autoComplete="off"
          placeholder={t("notePlaceholder")}
        />
      </div>
    </div>
  );
}

function Outcome({ state, warehouseId }: { state: Extract<AdjustmentState, { ok: true }>; warehouseId: string }) {
  const t = useTranslations("inventory.adjustmentForm");
  const posted = state.outcome === "posted" || state.outcome === "approved";
  return (
    <Alert tone={posted ? "success" : "info"} role="status" className="space-y-1">
      <p className="font-medium">{t(`outcome.${state.outcome}`)}</p>
      {state.approvalRequestId ? <p>{t("approvalRef", { ref: shortId(state.approvalRequestId) })}</p> : null}
      {state.replayed ? <p>{t("replayed")}</p> : null}
      {posted ? (
        <Link
          href={`/inventory/movements${toQuery({ warehouse: warehouseId, source_type: "adjustment" })}`}
          className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
        >
          {t("viewLedger")}
        </Link>
      ) : null}
    </Alert>
  );
}
