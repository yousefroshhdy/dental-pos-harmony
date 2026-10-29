"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * A destructive button that asks inline before acting (no browser `confirm()`,
 * so it works the same on phones and in tests). Module-local primitive.
 */
export function ConfirmAction({
  trigger,
  question,
  confirm,
  cancel,
  onConfirm,
  disabled,
}: {
  trigger: string;
  question: string;
  confirm: string;
  cancel: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const questionId = useId();

  if (!asking) {
    return (
      <Button type="button" variant="outline" disabled={disabled} onClick={() => setAsking(true)}>
        {trigger}
      </Button>
    );
  }

  return (
    <div role="group" aria-labelledby={questionId} className="flex w-full flex-col gap-2 rounded-md border border-destructive/40 p-3">
      <p id={questionId} className="text-sm">
        {question}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="destructive"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
              setAsking(false);
            }
          }}
        >
          {confirm}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setAsking(false)} autoFocus>
          {cancel}
        </Button>
      </div>
    </div>
  );
}
