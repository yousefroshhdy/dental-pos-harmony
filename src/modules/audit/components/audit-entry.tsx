import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/primitives";
import { Link } from "@/i18n/navigation";
import { CAIRO_DATE_TIME } from "../format";
import { actionTone, actorName, displayValue, fieldChanges, historyHref, isBlockValue, recordHref, tableKey, tableRef, type FieldChange } from "../logic";
import type { AuditEntry, Json } from "../types";

/** Display name of an audited table: translated when known, else schema.table. */
export async function tableLabel(schema: string, table: string): Promise<string> {
  const t = await getTranslations("audit");
  const key = tableKey(schema, table);
  return t.has(key) ? t(key) : tableRef(schema, table);
}

/**
 * One audit entry: when, what, who, and a field-level diff (old → new).
 * `showRecord` adds the table/record line and the timeline link (search results).
 */
export async function AuditEntryCard({ entry, showRecord }: { entry: AuditEntry; showRecord: boolean }) {
  const t = await getTranslations("audit");
  const format = await getFormatter();
  const locale = await getLocale();
  const changes = fieldChanges(entry);
  const href = recordHref(entry);
  const history = showRecord ? historyHref(entry.table_schema, entry.table_name, entry.record_id) : null;
  const who = actorName(locale, entry);
  const label = await tableLabel(entry.table_schema, entry.table_name);
  const headingId = `audit-entry-${entry.id}`;

  return (
    <article aria-labelledby={headingId} className="space-y-2 rounded-lg border bg-card p-3 sm:p-4">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-1">
          <h3 id={headingId} className="flex flex-wrap items-center gap-2 font-medium">
            <Badge tone={actionTone(entry.action)}>{t(`actions.${entry.action}`)}</Badge>
            <span>{label}</span>
            <code dir="ltr" className="text-xs text-muted-foreground">
              {tableRef(entry.table_schema, entry.table_name)}
            </code>
          </h3>
          <p className="text-sm text-muted-foreground">
            <time dateTime={entry.occurred_at}>{format.dateTime(new Date(entry.occurred_at), CAIRO_DATE_TIME)}</time>
            {" · "}
            {who ? t("entry.by", { name: who }) : t("entry.system")}
          </p>
          {showRecord ? (
            <p className="text-sm break-all">
              <span className="text-muted-foreground">{t("entry.record")} </span>
              <code dir="ltr" className="text-xs">
                {entry.record_id ?? t("entry.noRecordId")}
              </code>
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-x-4 sm:justify-end">
          {history ? (
            <Link href={history} prefetch={false} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
              {t("entry.history")}
            </Link>
          ) : null}
          {href ? (
            <Link href={href} prefetch={false} className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
              {t("entry.openRecord")}
            </Link>
          ) : null}
        </div>
      </header>

      {changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("entry.noChanges")}</p>
      ) : (
        <details open={entry.action === "UPDATE" && changes.length <= 8}>
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-primary">
            {t("entry.changes", { count: changes.length })}
          </summary>
          <dl className="mt-1 divide-y rounded-md border">
            {changes.map((change) => (
              <FieldRow key={change.field} change={change} action={entry.action} t={t} />
            ))}
          </dl>
        </details>
      )}

      {entry.request_id ? (
        <p className="text-xs text-muted-foreground">
          {t("entry.request")}{" "}
          <code dir="ltr" className="break-all">
            {entry.request_id}
          </code>
        </p>
      ) : null}
    </article>
  );
}

type Translate = Awaited<ReturnType<typeof getTranslations<"audit">>>;

function FieldRow({ change, action, t }: { change: FieldChange; action: AuditEntry["action"]; t: Translate }) {
  const showBefore = action !== "INSERT";
  const showAfter = action !== "DELETE";
  return (
    <div className="grid gap-1 p-2 text-sm sm:grid-cols-[minmax(8rem,12rem)_1fr] sm:gap-3">
      <dt className="flex flex-wrap items-center gap-2">
        <code dir="ltr" className="font-medium break-all">
          {change.field}
        </code>
        {action === "UPDATE" ? <span className="text-xs text-muted-foreground">{t(`kinds.${change.kind}`)}</span> : null}
      </dt>
      <dd className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:gap-2">
        {change.masked ? (
          <Badge tone="warning">{t("entry.masked", { category: t(`categories.${change.masked}`) })}</Badge>
        ) : (
          <>
            {showBefore ? <Value value={change.before} tone="before" t={t} /> : null}
            {showBefore && showAfter ? (
              <span aria-hidden="true" className="inline-block text-muted-foreground rtl:rotate-180">
                →
              </span>
            ) : null}
            {showBefore && showAfter ? <span className="sr-only">{t("entry.becomes")}</span> : null}
            {showAfter ? <Value value={change.after} tone="after" t={t} /> : null}
          </>
        )}
      </dd>
    </div>
  );
}

function Value({ value, tone, t }: { value: Json | undefined; tone: "before" | "after"; t: Translate }) {
  const text = displayValue(value);
  const label = tone === "before" ? t("entry.before") : t("entry.after");
  const color = tone === "before" ? "bg-destructive/10" : "bg-success/10";
  if (text === null) {
    return (
      <span className="text-muted-foreground italic">
        <span className="sr-only">{label}: </span>
        {t("entry.empty")}
      </span>
    );
  }
  if (isBlockValue(value)) {
    return (
      <pre dir="ltr" aria-label={label} className={`max-w-full overflow-x-auto rounded px-2 py-1 text-start text-xs whitespace-pre-wrap break-all ${color}`}>
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return (
    <span dir="auto" className={`rounded px-1.5 py-0.5 break-all ${color}`}>
      <span className="sr-only">{label}: </span>
      {text}
    </span>
  );
}
