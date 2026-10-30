import { Download } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { Card, Input, Label, Select } from "@/components/ui/primitives";
import { cairoToday } from "../csv";
import { optionLabelKey, type DynamicOptions, type FieldSpec, type Option } from "../forms";
import type { ExportKind } from "../kinds";

/**
 * One export card with its filter form. The form GETs /api/export/<kind>
 * directly, so the browser downloads the file (Content-Disposition) and no
 * client JavaScript is needed.
 */
export async function ExportForm({
  kind,
  fields,
  options,
  locale,
}: {
  kind: ExportKind;
  fields: readonly FieldSpec[];
  options: Partial<Record<DynamicOptions, Option[]>>;
  locale: string;
}) {
  const t = await getTranslations("reports");
  const title = t(`kinds.${kind}.title`);
  const headingId = `export-${kind}`;
  const id = (name: string) => `${kind}-${name}`;

  return (
    <Card className="flex flex-col gap-3">
      <div className="space-y-1">
        <h2 id={headingId} className="text-lg font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{t(`kinds.${kind}.description`)}</p>
      </div>
      <form method="get" action={`/api/export/${kind}`} aria-labelledby={headingId} className="flex flex-col gap-3">
        <input type="hidden" name="locale" value={locale} />
        {fields.length > 0 ? (
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="sr-only">{t("page.filtersLabel", { name: title })}</legend>
            {fields.map((f) => (
              <div key={f.name} className="flex min-w-0 flex-col gap-1">
                <Label htmlFor={id(f.name)}>{t(`filters.${f.name}`)}</Label>
                {f.control === "select" ? (
                  <Select id={id(f.name)} name={f.name} defaultValue={f.defaultValue ?? ""} className="w-full">
                    {f.anyOption ? <option value="">{t("filters.any")}</option> : null}
                    {f.codes.map((code) => (
                      <option key={code} value={code}>
                        {t(optionLabelKey(f.group, code))}
                      </option>
                    ))}
                  </Select>
                ) : f.control === "dynamic" ? (
                  <Select id={id(f.name)} name={f.name} defaultValue="" className="w-full">
                    <option value="">{t("filters.any")}</option>
                    {(options[f.source] ?? []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ) : f.control === "date" ? (
                  <Input id={id(f.name)} name={f.name} type="date" dir="ltr" defaultValue={f.defaultToday ? cairoToday() : undefined} />
                ) : (
                  <Input id={id(f.name)} name={f.name} type="search" maxLength={80} placeholder={t("filters.qPlaceholder")} />
                )}
              </div>
            ))}
          </fieldset>
        ) : null}
        <Button type="submit" className="min-h-11 w-full gap-2 sm:w-auto sm:self-start">
          <Download aria-hidden="true" className="size-4" />
          {t("page.download")}
        </Button>
      </form>
    </Card>
  );
}
