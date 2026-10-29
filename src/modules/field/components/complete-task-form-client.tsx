"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { useRouter } from "@/i18n/navigation";
import type { JsonObject } from "@/lib/offline/types";
import { cn } from "@/lib/utils";
import { sendCompleteTask } from "../device";
import { deviceQueueId, FIELD_QUEUED_COMMANDS } from "../logic";
import { completeTaskSchema, invalidFieldsOf, type CompleteTaskPayload } from "../schemas";
import type { CompleteTaskResult } from "../types";
import { useDeviceSubmit, useQueuedItem } from "../use-device-queue";
import { FieldError } from "./field-error";
import { QueuedNotice } from "./queued-notice";

type SendError = { code: string; messageKey: Parameters<typeof FieldError>[0]["messageKey"]; requestId?: string };

/**
 * Mark a task done with an outcome (api.complete_task; a replay of a done task
 * is a no-op). Offline, the completion is saved on the device and sent later.
 * Folded inside <details> so lists stay compact.
 */
export function CompleteTaskFormClient({ taskId, title, userId }: { taskId: string; title: string; userId: string }) {
  const t = useTranslations("field.tasks");
  const tOffline = useTranslations("field.offline");
  const router = useRouter();
  const inputId = useId();
  const queueId = deviceQueueId(FIELD_QUEUED_COMMANDS.completeTask, taskId);
  const [outcome, setOutcome] = useState("");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<SendError | null>(null);
  // A failed, retryable payload is re-sent unchanged.
  const [retryPayload, setRetryPayload] = useState<CompleteTaskPayload | null>(null);
  const submit = useDeviceSubmit(userId);
  const saved = useQueuedItem(userId, queueId);
  const savedSynced = saved?.status === "done";

  // A saved completion reached the server: reload the list from the server.
  useEffect(() => {
    if (savedSynced) router.refresh();
    // Runs once when the saved completion syncs; the router's identity is not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedSynced]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let payload = retryPayload;
    if (!payload) {
      // Validate before saving: an invalid payload must never sit in the queue.
      const parsed = completeTaskSchema.safeParse({ task_id: taskId, outcome });
      if (!parsed.success) {
        const missing = invalidFieldsOf(parsed.error).includes("outcome");
        return setError({ code: "VALIDATION", messageKey: missing ? "REASON_REQUIRED" : "VALIDATION" });
      }
      payload = parsed.data;
    }
    setPending(true);
    const sendPayload = payload;
    const r = await submit<CompleteTaskResult>(
      { command: FIELD_QUEUED_COMMANDS.completeTask, id: queueId, args: sendPayload as unknown as JsonObject, groupKey: `task:${taskId}` },
      () => sendCompleteTask(sendPayload),
    );
    setPending(false);
    if (r.kind === "sent") {
      setRetryPayload(null);
      setDone(true); // the action revalidates the list; this covers the moment before it re-renders
    } else if (r.kind === "queued") {
      setRetryPayload(null);
    } else {
      setError({ code: r.code, messageKey: r.messageKey, requestId: r.requestId });
      setRetryPayload(r.retryable ? sendPayload : null);
    }
  }

  if (done || savedSynced) {
    return (
      <Alert tone="success" role="status">
        {tOffline("taskDone")}
      </Alert>
    );
  }
  if (saved) return <QueuedNotice item={saved} message={tOffline("task")} />;

  return (
    <details className="w-full sm:w-auto">
      <summary
        className={cn(buttonVariants({ variant: "outline" }), "w-full cursor-pointer list-none select-none sm:w-auto [&::-webkit-details-marker]:hidden")}
        aria-label={t("completeFor", { title })}
      >
        {t("complete")}
      </summary>
      <form onSubmit={onSubmit} className="mt-2 flex min-w-60 flex-col gap-2" noValidate>
        <Label htmlFor={inputId}>{t("outcomeLabel")}</Label>
        <Input
          id={inputId}
          name="outcome"
          required
          minLength={2}
          maxLength={1000}
          value={outcome}
          disabled={retryPayload !== null}
          onChange={(e) => setOutcome(e.target.value)}
          placeholder={t("outcomePlaceholder")}
          autoComplete="off"
          aria-invalid={error?.messageKey === "REASON_REQUIRED" ? true : undefined}
        />
        <Button type="submit" disabled={pending}>
          {t("completeConfirm")}
        </Button>
        {error ? <FieldError code={error.code} messageKey={error.messageKey} requestId={error.requestId} /> : null}
      </form>
    </details>
  );
}
