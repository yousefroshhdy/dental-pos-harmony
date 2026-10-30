import { toCents } from "./logic";
import type { InvoiceLineRow, Numeric, PaymentRow } from "./types";

/**
 * Pure helpers of the printable invoice and payment receipt. The documents are
 * rendered on the server from api.* reads; every amount on them comes from the
 * database (nothing is recomputed here except grouping the VAT lines by rate).
 */

export const DOC_LANGS = ["ar", "en"] as const;
export type DocLang = (typeof DOC_LANGS)[number];

/** Document language from ?lang=; Arabic (the legal language of the document) by default. */
export function parseDocLang(value: string | string[] | undefined): DocLang {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "en" ? "en" : "ar";
}

export const docDir = (lang: DocLang): "rtl" | "ltr" => (lang === "ar" ? "rtl" : "ltr");

/** The company.* settings returned by api.company_profile() (all strings; missing = ""). */
export interface CompanyProfile {
  name: string;
  legal_name_ar: string;
  legal_name_en: string;
  address_ar: string;
  address_en: string;
  tax_registration_no: string;
  commercial_register_no: string;
  phone: string;
  logo_url: string;
}

const PROFILE_KEYS = [
  "name",
  "legal_name_ar",
  "legal_name_en",
  "address_ar",
  "address_en",
  "tax_registration_no",
  "commercial_register_no",
  "phone",
  "logo_url",
] as const satisfies readonly (keyof CompanyProfile)[];

/** Keep only the known keys with string values (the settings are owner-edited JSON). */
export function parseCompanyProfile(raw: unknown): CompanyProfile {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = {} as CompanyProfile;
  for (const key of PROFILE_KEYS) {
    const value = source[key];
    out[key] = typeof value === "string" ? value.trim() : "";
  }
  return out;
}

/** An https URL or a same-origin absolute path; anything else (javascript:, data:, http:, //host) is dropped. */
export function safeLogoUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname ? url.toString() : null;
  } catch {
    return null;
  }
}

export interface CompanyHeader {
  name: string;
  address: string;
  taxRegistrationNo: string;
  commercialRegisterNo: string;
  phone: string;
  logoUrl: string | null;
}

/** The header block in the document's language, falling back to the other language, then the display name. */
export function companyHeader(profile: CompanyProfile, lang: DocLang): CompanyHeader {
  const pick = (ar: string, en: string) => (lang === "ar" ? ar || en : en || ar);
  return {
    name: pick(profile.legal_name_ar, profile.legal_name_en) || profile.name,
    address: pick(profile.address_ar, profile.address_en),
    taxRegistrationNo: profile.tax_registration_no,
    commercialRegisterNo: profile.commercial_register_no,
    phone: profile.phone,
    logoUrl: safeLogoUrl(profile.logo_url),
  };
}

export interface VatGroup {
  rate: number;
  /** Line amounts after discount, before VAT. */
  taxable: number;
  vat: number;
}

/** VAT summary of a printed invoice: one row per rate, in cents so sums never drift. */
export function vatSummary(lines: readonly Pick<InvoiceLineRow, "tax_rate_pct" | "line_subtotal" | "discount" | "tax_amount">[]): VatGroup[] {
  const groups = new Map<number, { taxable: number; vat: number }>();
  for (const l of lines) {
    const rate = toCents(l.tax_rate_pct) / 100;
    const g = groups.get(rate) ?? { taxable: 0, vat: 0 };
    g.taxable += toCents(l.line_subtotal) - toCents(l.discount);
    g.vat += toCents(l.tax_amount);
    groups.set(rate, g);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => b - a)
    .map(([rate, g]) => ({ rate, taxable: g.taxable / 100, vat: g.vat / 100 }));
}

/** Only a confirmed payment has a receipt (pending, bounced and reversed ones never do). */
export const hasReceipt = (payment: Pick<PaymentRow, "status">): boolean => payment.status === "confirmed";

/** Non-zero amounts only (the printed invoice shows paid / credited / written off when they apply). */
export const nonZero = (value: Numeric | null | undefined): boolean => toCents(value) !== 0;
