"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { createTransfer } from "../actions";
import { MAX_LINES } from "../schemas";
import { InventoryActionMessage, useKeepValuesAction } from "./inventory-error";
import type { WarehouseChoice } from "./receipt-form";

export interface StockLineChoice {
  /** `variant_id:lot_id` */
  value: string;
  label: string;
  available: number;
}

interface Line {
  key: number;
  line: string;
  quantity: string;
}

/**
 * New transfer from one (already chosen) source warehouse. Lines pick a lot
 * that has available stock there. Creates a DRAFT; shipping it later moves the
 * stock out of the source and into transit.
 */
export function TransferForm({
  locale,
  fromWarehouseId,
  destinations,
  stockLines,
}: {
  locale: string;
  fromWarehouseId: string;
  destinations: WarehouseChoice[];
  stockLines: StockLineChoice[];
}) {
  const t = useTranslations("inventory.transferForm");
  const tKinds = useTranslations("inventory.kinds");
  const [state, onSubmit, pending] = useKeepValuesAction(createTransfer, null);
  const [toId, setToId] = useState("");
  const [lines, setLines] = useState<Line[]>([{ key: 1, line: "", quantity: "" }]);
  const [nextKey, setNextKey] = useState(2);

  const destination = destinations.find((w) => w.id === toId);
  const byValue = new Map(stockLines.map((s) => [s.value, s]));
  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <form onSubmit={onSubmit} className="space-y-6" aria-busy={pending}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="from_warehouse_id" value={fromWarehouseId} />

      <div className="space-y-2">
        <Label htmlFor="transfer-to">{t("to")}</Label>
        <Select id="transfer-to" name="to_warehouse_id" required value={toId} onChange={(e) => setToId(e.target.value)} className="w-full">
          <option value="" disabled>
            {t("selectDestination")}
          </option>
          {destinations.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label} — {tKinds(w.kind)}
              {w.sellable ? "" : ` (${t("notSellableShort")})`}
            </option>
          ))}
        </Select>
        {destination && !destination.sellable ? (
          <Alert tone="info" role="status">
            {t("notSellableDestination", { kind: tKinds(destination.kind) })}
          </Alert>
        ) : null}
      </div>

      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">{t("lines")}</legend>
        {stockLines.length === 0 ? <p className="text-sm text-muted-foreground">{t("noStock")}</p> : null}
        <ol className="space-y-3">
          {lines.map((line, index) => {
            const chosen = byValue.get(line.line);
            const id = `tl-${line.key}`;
            return (
              <li key={line.key} className="rounded-md border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{t("lineN", { n: index + 1 })}</span>
                  {lines.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="min-h-11"
                      onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}
                    >
                      {t("removeLine")}
                    </Button>
                  ) : null}
                </div>
                <div className="grid gap-3 sm:grid-cols-4">
                  <div className="space-y-1 sm:col-span-3">
                    <Label htmlFor={`${id}-line`}>{t("lot")}</Label>
                    <Select
                      id={`${id}-line`}
                      name="line"
                      required
                      value={line.line}
                      onChange={(e) => update(line.key, { line: e.target.value })}
                      className="w-full"
                    >
                      <option value="" disabled>
                        {t("selectLot")}
                      </option>
                      {stockLines.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-qty`}>{t("quantity")}</Label>
                    <Input
                      id={`${id}-qty`}
                      name="quantity"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={chosen?.available ?? 1000000}
                      step={1}
                      required
                      dir="ltr"
                      value={line.quantity}
                      onChange={(e) => update(line.key, { quantity: e.target.value })}
                      aria-describedby={chosen ? `${id}-avail` : undefined}
                    />
                    {chosen ? (
                      <p id={`${id}-avail`} className="text-xs text-muted-foreground">
                        {t("availableN", { n: chosen.available })}
                      </p>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        <Button
          type="button"
          variant="outline"
          disabled={lines.length >= MAX_LINES || stockLines.length === 0}
          onClick={() => {
            setLines((ls) => [...ls, { key: nextKey, line: "", quantity: "" }]);
            setNextKey((k) => k + 1);
          }}
        >
          {t("addLine")}
        </Button>
      </fieldset>

      <InventoryActionMessage state={state} />

      <div className="sticky bottom-0 -mx-4 border-t bg-card/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
        <Button type="submit" disabled={pending || stockLines.length === 0} className="w-full sm:w-auto">
          {t("submit")}
        </Button>
        <p className="mt-2 text-xs text-muted-foreground">{t("submitHint")}</p>
      </div>
    </form>
  );
}
