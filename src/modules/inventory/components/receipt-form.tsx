"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { createReceipt } from "../actions";
import { receiptLineIssues } from "../logic";
import { MAX_LINES } from "../schemas";
import type { WarehouseKind } from "../types";
import { InventoryActionMessage, useKeepValuesAction } from "./inventory-error";

export interface WarehouseChoice {
  id: string;
  label: string;
  kind: WarehouseKind;
  sellable: boolean;
}

export interface VariantChoice {
  id: string;
  label: string;
  lotTracked: boolean;
  expiryTracked: boolean;
}

interface Line {
  key: number;
  variant_id: string;
  lot_no: string;
  expiry_date: string;
  quantity: string;
  unit_cost: string;
}

const blank = (key: number): Line => ({ key, variant_id: "", lot_no: "", expiry_date: "", quantity: "", unit_cost: "" });

/**
 * New goods receipt: header + lines (lot number, expiry, quantity, optional
 * purchase cost from the supplier document). Creates a DRAFT — nothing moves
 * until it is posted on the next screen. On success the action redirects there.
 */
export function ReceiptForm({
  locale,
  warehouses,
  variants,
  today,
  defaultWarehouseId,
}: {
  locale: string;
  warehouses: WarehouseChoice[];
  variants: VariantChoice[];
  today: string;
  defaultWarehouseId?: string;
}) {
  const t = useTranslations("inventory.receiptForm");
  const tKinds = useTranslations("inventory.kinds");
  const [state, onSubmit, pending] = useKeepValuesAction(createReceipt, null);
  const [warehouseId, setWarehouseId] = useState(defaultWarehouseId ?? "");
  const [lines, setLines] = useState<Line[]>([blank(1)]);
  const [nextKey, setNextKey] = useState(2);

  const warehouse = warehouses.find((w) => w.id === warehouseId);
  const variantById = new Map(variants.map((v) => [v.id, v]));

  const update = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () => {
    setLines((ls) => [...ls, blank(nextKey)]);
    setNextKey((k) => k + 1);
  };
  const removeLine = (key: number) => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls));

  const chooseVariant = (line: Line, variantId: string) => {
    const v = variantById.get(variantId);
    // Untracked products use the NO-LOT convention (ADR-013).
    const lot = v && !v.lotTracked && line.lot_no === "" ? "NO-LOT" : line.lot_no;
    update(line.key, { variant_id: variantId, lot_no: lot });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-6" aria-busy={pending}>
      <input type="hidden" name="locale" value={locale} />

      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="sr-only">{t("header")}</legend>
        <div className="space-y-2">
          <Label htmlFor="receipt-warehouse">{t("warehouse")}</Label>
          <Select
            id="receipt-warehouse"
            name="warehouse_id"
            required
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            className="w-full"
          >
            <option value="" disabled>
              {t("selectWarehouse")}
            </option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label} — {tKinds(w.kind)}
                {w.sellable ? "" : ` (${t("notSellableShort")})`}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="receipt-supplier">{t("supplier")}</Label>
          <Input id="receipt-supplier" name="supplier" required minLength={2} maxLength={200} autoComplete="off" placeholder={t("supplierPlaceholder")} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="receipt-shipment">
            {t("shipmentRef")} <span className="text-muted-foreground">({t("optional")})</span>
          </Label>
          <Input id="receipt-shipment" name="shipment_ref" maxLength={100} dir="ltr" autoComplete="off" />
        </div>
      </fieldset>

      {warehouse && !warehouse.sellable ? (
        <Alert tone="info" role="status">
          {t("notSellableWarehouse", { kind: tKinds(warehouse.kind) })}
        </Alert>
      ) : null}

      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">{t("lines")}</legend>
        <p className="text-sm text-muted-foreground">{t("linesHint")}</p>
        <ol className="space-y-3">
          {lines.map((line, index) => {
            const v = variantById.get(line.variant_id);
            const issues = receiptLineIssues(
              { expiry_date: line.expiry_date || null },
              { expiryTracked: v?.expiryTracked ?? false, warehouseKind: warehouse?.kind, today },
            );
            const id = `rl-${line.key}`;
            return (
              <li key={line.key} className="rounded-md border p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{t("lineN", { n: index + 1 })}</span>
                  {lines.length > 1 ? (
                    <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={() => removeLine(line.key)}>
                      {t("removeLine")}
                    </Button>
                  ) : null}
                </div>
                <div className="grid gap-3 sm:grid-cols-6">
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor={`${id}-variant`}>{t("variant")}</Label>
                    <Select
                      id={`${id}-variant`}
                      name="variant_id"
                      required
                      value={line.variant_id}
                      onChange={(e) => chooseVariant(line, e.target.value)}
                      className="w-full"
                    >
                      <option value="" disabled>
                        {t("selectVariant")}
                      </option>
                      {variants.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-lot`}>{t("lotNo")}</Label>
                    <Input
                      id={`${id}-lot`}
                      name="lot_no"
                      required
                      maxLength={60}
                      dir="ltr"
                      autoComplete="off"
                      value={line.lot_no}
                      onChange={(e) => update(line.key, { lot_no: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-expiry`}>
                      {t("expiry")} {v?.expiryTracked ? null : <span className="text-muted-foreground">({t("optional")})</span>}
                    </Label>
                    <Input
                      id={`${id}-expiry`}
                      name="expiry_date"
                      type="date"
                      dir="ltr"
                      required={v?.expiryTracked ?? false}
                      value={line.expiry_date}
                      onChange={(e) => update(line.key, { expiry_date: e.target.value })}
                      aria-describedby={issues.length ? `${id}-issues` : undefined}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-qty`}>{t("quantity")}</Label>
                    <Input
                      id={`${id}-qty`}
                      name="quantity"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={1000000}
                      step={1}
                      required
                      dir="ltr"
                      value={line.quantity}
                      onChange={(e) => update(line.key, { quantity: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-cost`}>
                      {t("unitCost")} <span className="text-muted-foreground">({t("optional")})</span>
                    </Label>
                    <Input
                      id={`${id}-cost`}
                      name="unit_cost"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.01"
                      dir="ltr"
                      placeholder={t("unitCostPlaceholder")}
                      value={line.unit_cost}
                      onChange={(e) => update(line.key, { unit_cost: e.target.value })}
                    />
                  </div>
                </div>
                {issues.length ? (
                  <ul id={`${id}-issues`} className="mt-2 space-y-1 text-sm text-destructive">
                    {issues.map((issue) => (
                      <li key={issue}>{t(`issue.${issue}`)}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
        <Button type="button" variant="outline" onClick={addLine} disabled={lines.length >= MAX_LINES}>
          {t("addLine")}
        </Button>
      </fieldset>

      <InventoryActionMessage state={state} />

      <div className="sticky bottom-0 -mx-4 border-t bg-card/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {t("submit")}
        </Button>
        <p className="mt-2 text-xs text-muted-foreground">{t("submitHint")}</p>
      </div>
    </form>
  );
}
