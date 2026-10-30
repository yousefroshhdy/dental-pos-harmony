"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label, Select } from "@/components/ui/primitives";
import { uploadBatch } from "../actions";
import type { ImportKind } from "../kinds";
import { MAX_FILE_BYTES } from "../logic";
import type { ActionState } from "../types";
import { ActionMessage } from "./import-error";

/**
 * Upload a CSV for one kind. The file is parsed on the server (no XLSX: "Save as CSV
 * (UTF-8)"); a device-generated idempotency key is kept for every retry of the same
 * attempt, so a retried upload opens the same batch instead of staging it twice.
 */
export function UploadForm({ kinds, defaultKind, locale }: { kinds: ImportKind[]; defaultKind?: ImportKind; locale: string }) {
  const t = useTranslations("imports.upload");
  const tKinds = useTranslations("imports.kinds");
  const kindId = useId();
  const fileId = useId();
  const hintId = useId();
  const keyRef = useRef<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);
  const [, startTransition] = useTransition();
  const [state, dispatch, pending] = useActionState<ActionState, FormData>(uploadBatch, null);

  return (
    <form
      method="post"
      encType="multipart/form-data"
      aria-label={t("title")}
      className="grid gap-4 sm:grid-cols-[1fr_2fr_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const file = form.get("file");
        if (file instanceof File && file.size > MAX_FILE_BYTES) {
          setTooLarge(true);
          return;
        }
        setTooLarge(false);
        keyRef.current ??= crypto.randomUUID();
        form.set("idempotency_key", keyRef.current);
        startTransition(() => dispatch(form));
      }}
      onChange={() => {
        // A different file or kind is a new attempt.
        keyRef.current = null;
      }}
    >
      <input type="hidden" name="locale" value={locale} />
      <div className="space-y-1">
        <Label htmlFor={kindId}>{t("kind")}</Label>
        <Select id={kindId} name="kind" defaultValue={defaultKind ?? kinds[0]} className="w-full" required>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {tKinds(`${k}.title`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={fileId}>{t("file")}</Label>
        <Input
          id={fileId}
          name="file"
          type="file"
          accept=".csv,text/csv"
          required
          aria-describedby={hintId}
          className="py-2 file:me-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1"
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          {t("fileHint")}
        </p>
      </div>
      <Button type="submit" disabled={pending} aria-busy={pending || undefined} className="w-full sm:w-auto">
        {pending ? t("uploading") : t("submit")}
      </Button>
      {tooLarge ? <Alert className="col-span-full">{t("problems.too_large")}</Alert> : null}
      <ActionMessage state={state} className="col-span-full" />
    </form>
  );
}
