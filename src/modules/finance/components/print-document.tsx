import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { docDir, type CompanyHeader, type DocLang } from "../print";
import { BackLink } from "./bits";
import { PrintButton } from "./print-button";

/**
 * Building blocks of the printable A4 documents (invoice, payment receipt). Print CSS
 * only — no PDF library: the browser's "Print / Save as PDF" produces the file.
 *
 * The app shell (layout header, main padding) is shared, so the print rules that hide
 * it live here, scoped to @media print and to this page only.
 */
const PRINT_CSS = `
@page { size: A4; margin: 12mm; }
@media print {
  html, body { background: #fff !important; }
  body header.sticky { display: none !important; }
  body main { max-width: none !important; padding: 0 !important; margin: 0 !important; }
  .fin-doc { border: 0 !important; box-shadow: none !important; padding: 0 !important; max-width: none !important; }
  .fin-doc-scroll { overflow: visible !important; }
  .fin-doc table { page-break-inside: auto; }
  .fin-doc tr { page-break-inside: avoid; }
  .fin-doc-keep { page-break-inside: avoid; }
}
`;

export function PrintStyles() {
  return <style>{PRINT_CSS}</style>;
}

/** Screen-only bar: back, language of the document, print. */
export function PrintToolbar({
  backHref,
  backLabel,
  basePath,
  lang,
  labels,
}: {
  backHref: string;
  backLabel: string;
  basePath: string;
  lang: DocLang;
  labels: { language: string; ar: string; en: string; print: string };
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
      <BackLink href={backHref} label={backLabel} />
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label={labels.language} className="flex gap-2">
          {(["ar", "en"] as const).map((l) => (
            <Link
              key={l}
              href={`${basePath}?lang=${l}`}
              aria-current={lang === l ? "page" : undefined}
              lang={l}
              className={cn(buttonVariants({ variant: lang === l ? "default" : "outline", size: "sm" }), "min-h-11")}
            >
              {labels[l]}
            </Link>
          ))}
        </nav>
        <PrintButton label={labels.print} />
      </div>
    </div>
  );
}

/** The A4 sheet. Its language and direction are the document's, not the app's. */
export function PrintSheet({ lang, label, children }: { lang: DocLang; label: string; children: ReactNode }) {
  return (
    <article
      lang={lang}
      dir={docDir(lang)}
      aria-label={label}
      className="fin-doc mx-auto w-full max-w-[210mm] space-y-6 rounded-md border bg-white p-4 text-sm text-neutral-900 shadow-sm sm:p-8 print:text-[11pt]"
    >
      {children}
    </article>
  );
}

/** Company header (logo, legal name, address, registration numbers) beside the document title block. */
export function CompanyBlock({
  company,
  labels,
  aside,
}: {
  company: CompanyHeader;
  labels: { taxNo: string; commercialNo: string; phone: string };
  aside: ReactNode;
}) {
  return (
    <div className="fin-doc-keep flex flex-col gap-4 border-b border-neutral-300 pb-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-3">
        {company.logoUrl ? (
          // A plain <img>: the logo URL is an owner setting (https or same-origin only, see safeLogoUrl).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={company.logoUrl} alt="" className="h-14 w-auto max-w-32 object-contain" />
        ) : null}
        <div className="space-y-0.5">
          <p className="text-lg font-bold">{company.name}</p>
          {company.address ? <p>{company.address}</p> : null}
          {company.phone ? (
            <p>
              {labels.phone}: <span dir="ltr">{company.phone}</span>
            </p>
          ) : null}
          {company.taxRegistrationNo ? (
            <p>
              {labels.taxNo}: <span dir="ltr">{company.taxRegistrationNo}</span>
            </p>
          ) : null}
          {company.commercialRegisterNo ? (
            <p>
              {labels.commercialNo}: <span dir="ltr">{company.commercialRegisterNo}</span>
            </p>
          ) : null}
        </div>
      </div>
      <div className="space-y-1 sm:text-end">{aside}</div>
    </div>
  );
}

/** Label: value line of a document block. */
export function DocField({ label, value, ltr = false }: { label: string; value: ReactNode; ltr?: boolean }) {
  return (
    <p>
      <span className="text-neutral-600">{label}: </span>
      <span className="font-medium" dir={ltr ? "ltr" : undefined}>
        {value}
      </span>
    </p>
  );
}

/** One totals row; `strong` for the grand total. */
export function TotalRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? "flex justify-between gap-4 border-t border-neutral-400 pt-1 font-bold" : "flex justify-between gap-4"}>
      <span>{label}</span>
      <span className="whitespace-nowrap">{value}</span>
    </div>
  );
}

/** "Amount in words" box. */
export function AmountWords({ label, words }: { label: string; words: string }) {
  return (
    <div className="fin-doc-keep rounded border border-neutral-300 p-3">
      <span className="text-neutral-600">{label}: </span>
      <span className="font-medium">{words}</span>
    </div>
  );
}
