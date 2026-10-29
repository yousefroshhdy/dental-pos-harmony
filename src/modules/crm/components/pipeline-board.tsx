"use client";

import { useTranslations } from "next-intl";
import { startTransition, useActionState, useId, useState, type DragEvent } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge, Input, Label, Select } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { moveOpportunity } from "../actions";
import { opportunityTone, opportunityTransitionAllowed } from "../logic";
import type { ActionState, OpportunityStage } from "../types";
import { CrmActionMessage } from "./crm-error";

/** One pipeline card, pre-formatted on the server (money in EGP, dates in Cairo time). */
export interface PipelineCard {
  id: string;
  title: string;
  stage: OpportunityStage;
  customerId: string;
  customerName: string;
  customerNo: string | null;
  value: string | null;
  closeDate: string | null;
  owner: string;
  brand: string | null;
  lostReason: string | null;
  nextStages: OpportunityStage[];
}

export interface PipelineColumn {
  stage: OpportunityStage;
  count: number;
  total: string;
  cards: PipelineCard[];
}

const DRAG_TYPE = "application/x-honest-opportunity";

/**
 * Opportunities grouped by stage. On wide screens a card can be dragged to
 * another column; everywhere (and for keyboard users) each card has a "move to"
 * form, and on phones a stage selector shows one column at a time. Moving to
 * "lost" always asks for a reason. The database decides whether a move is allowed.
 */
export function PipelineBoard({ columns, canManage }: { columns: PipelineColumn[]; canManage: boolean }) {
  const t = useTranslations("crm.pipeline");
  const tStage = useTranslations("crm.opportunityStage");
  const [visible, setVisible] = useState<OpportunityStage>(() => columns.find((c) => c.count > 0)?.stage ?? "new");
  const [dragging, setDragging] = useState<{ id: string; from: OpportunityStage } | null>(null);
  const [overStage, setOverStage] = useState<OpportunityStage | null>(null);
  const [lostPrompt, setLostPrompt] = useState<string | null>(null);
  const [dropState, dropAction, dropPending] = useActionState<ActionState, FormData>(moveOpportunity, null);
  const selectId = useId();

  function onDrop(e: DragEvent, to: OpportunityStage) {
    e.preventDefault();
    setOverStage(null);
    const card = dragging;
    setDragging(null);
    if (!card || !opportunityTransitionAllowed(card.from, to)) return;
    if (to === "lost") {
      setLostPrompt(card.id);
      return;
    }
    const form = new FormData();
    form.set("opportunity_id", card.id);
    form.set("stage", to);
    startTransition(() => dropAction(form));
  }

  return (
    <div className="space-y-4">
      <div className="md:hidden">
        <Label htmlFor={selectId}>{t("showStage")}</Label>
        <Select id={selectId} value={visible} onChange={(e) => setVisible(e.target.value as OpportunityStage)} className="mt-2 w-full">
          {columns.map((c) => (
            <option key={c.stage} value={c.stage}>
              {tStage(c.stage)} ({c.count})
            </option>
          ))}
        </Select>
      </div>

      <div aria-live="polite">
        {dropPending ? <p className="text-sm text-muted-foreground">{t("moving")}</p> : null}
        <CrmActionMessage state={dropState} />
      </div>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        {columns.map((column) => {
          const droppable = dragging !== null && opportunityTransitionAllowed(dragging.from, column.stage);
          return (
            <section
              key={column.stage}
              aria-labelledby={`stage-${column.stage}`}
              className={cn(
                "min-w-0 space-y-3 rounded-lg border bg-muted/40 p-3",
                column.stage === visible ? "block" : "hidden md:block",
                droppable && "border-dashed border-primary",
                overStage === column.stage && droppable && "bg-primary/10",
              )}
              onDragOver={(e) => {
                if (!droppable) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overStage !== column.stage) setOverStage(column.stage);
              }}
              onDragLeave={() => setOverStage((s) => (s === column.stage ? null : s))}
              onDrop={(e) => onDrop(e, column.stage)}
            >
              <header className="flex items-baseline justify-between gap-2">
                <h2 id={`stage-${column.stage}`} className="font-semibold">
                  {tStage(column.stage)} <span className="text-sm font-normal text-muted-foreground">({column.count})</span>
                </h2>
                <span className="text-xs text-muted-foreground" dir="ltr">
                  {column.total}
                </span>
              </header>
              {column.cards.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("emptyStage")}</p>
              ) : (
                <ul className="space-y-2">
                  {column.cards.map((card) => (
                    <li key={card.id}>
                      <OpportunityCard
                        card={card}
                        canManage={canManage}
                        promptLost={lostPrompt === card.id}
                        onCancelLost={() => setLostPrompt(null)}
                        onDragStart={() => setDragging({ id: card.id, from: card.stage })}
                        onDragEnd={() => {
                          setDragging(null);
                          setOverStage(null);
                        }}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function OpportunityCard({
  card,
  canManage,
  promptLost,
  onCancelLost,
  onDragStart,
  onDragEnd,
}: {
  card: PipelineCard;
  canManage: boolean;
  promptLost: boolean;
  onCancelLost: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const t = useTranslations("crm.pipeline");
  const tStage = useTranslations("crm.opportunityStage");
  const movable = canManage && card.nextStages.length > 0;

  return (
    <article
      className="space-y-2 rounded-md border bg-card p-3 shadow-sm"
      draggable={movable}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, card.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 font-medium break-words">{card.title}</h3>
        {card.stage === "won" || card.stage === "lost" ? <Badge tone={opportunityTone(card.stage)}>{tStage(card.stage)}</Badge> : null}
      </div>
      <Link
        href={`/customers/${card.customerId}`}
        className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline"
      >
        {card.customerName}
        {card.customerNo ? (
          <span dir="ltr" className="ms-1 text-xs text-muted-foreground">
            {card.customerNo}
          </span>
        ) : null}
      </Link>
      <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
        {card.value ? (
          <>
            <dt className="text-muted-foreground">{t("value")}</dt>
            <dd dir="ltr" className="text-end">
              {card.value}
            </dd>
          </>
        ) : null}
        {card.closeDate ? (
          <>
            <dt className="text-muted-foreground">{t("closeDate")}</dt>
            <dd className="text-end">{card.closeDate}</dd>
          </>
        ) : null}
        {card.brand ? (
          <>
            <dt className="text-muted-foreground">{t("brand")}</dt>
            <dd className="text-end">{card.brand}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t("owner")}</dt>
        <dd className="text-end">{card.owner}</dd>
      </dl>
      {card.lostReason ? <p className="text-xs text-muted-foreground">{t("lostReason", { reason: card.lostReason })}</p> : null}
      {movable ? <MoveStageForm card={card} promptLost={promptLost} onCancelLost={onCancelLost} /> : null}
    </article>
  );
}

function MoveStageForm({ card, promptLost, onCancelLost }: { card: PipelineCard; promptLost: boolean; onCancelLost: () => void }) {
  const t = useTranslations("crm.pipeline");
  const tStage = useTranslations("crm.opportunityStage");
  const [state, formAction, pending] = useActionState<ActionState, FormData>(moveOpportunity, null);
  const [stage, setStage] = useState<OpportunityStage>(promptLost ? "lost" : (card.nextStages[0] ?? card.stage));
  const uid = useId();
  const chosen = promptLost ? "lost" : stage;

  return (
    <details open={promptLost || undefined} className="group">
      <summary
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "min-h-11 w-full cursor-pointer list-none select-none [&::-webkit-details-marker]:hidden")}
      >
        {t("move")}
      </summary>
      <form action={formAction} className="mt-2 space-y-2">
        <input type="hidden" name="opportunity_id" value={card.id} />
        <Label htmlFor={`${uid}-stage`}>{t("moveTo")}</Label>
        <Select
          id={`${uid}-stage`}
          name="stage"
          value={chosen}
          onChange={(e) => setStage(e.target.value as OpportunityStage)}
          className="w-full"
        >
          {card.nextStages.map((s) => (
            <option key={s} value={s}>
              {tStage(s)}
            </option>
          ))}
        </Select>
        {chosen === "lost" ? (
          <div className="space-y-1">
            <Label htmlFor={`${uid}-reason`}>{t("lostReasonLabel")}</Label>
            <Input id={`${uid}-reason`} name="lost_reason" required minLength={3} maxLength={500} autoFocus={promptLost} autoComplete="off" />
          </div>
        ) : null}
        <Button type="submit" size="sm" disabled={pending} className="min-h-11 w-full">
          {t("confirmMove")}
        </Button>
        {promptLost ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancelLost} className="min-h-11 w-full">
            {t("cancel")}
          </Button>
        ) : null}
        <CrmActionMessage state={state} />
      </form>
    </details>
  );
}
