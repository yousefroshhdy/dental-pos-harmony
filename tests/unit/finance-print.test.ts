import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANONYMOUS_CONTEXT, type Grant, type UserContext } from "@/lib/authz/can";
import { canWriteOffInvoice, checkWriteOffAmount, FINANCE_ERROR_CODES } from "@/modules/finance/logic";
import {
  companyHeader,
  docDir,
  hasReceipt,
  nonZero,
  parseCompanyProfile,
  parseDocLang,
  safeLogoUrl,
  vatSummary,
} from "@/modules/finance/print";
import { writeOffSchema } from "@/modules/finance/schemas";

const MIGRATION = readFileSync(join(__dirname, "../../supabase/migrations/20261103000500_finance_write_off_print.sql"), "utf8");
const DISPATCH = readFileSync(join(__dirname, "../../supabase/migrations/20261103000599_dispatch.sql"), "utf8");

const ctx = (codes: string[]): UserContext => ({
  ...ANONYMOUS_CONTEXT,
  user_id: "00000000-0000-0000-0000-0000000000a6",
  active: true,
  status: "active",
  permissions: Object.fromEntries(codes.map((c): [string, Grant] => [c, { scope: "all", limit: null }])),
});

describe("document language", () => {
  it("is Arabic unless English is asked for", () => {
    expect(parseDocLang(undefined)).toBe("ar");
    expect(parseDocLang("en")).toBe("en");
    expect(parseDocLang(["en", "ar"])).toBe("en");
    expect(parseDocLang("fr")).toBe("ar");
    expect(docDir("ar")).toBe("rtl");
    expect(docDir("en")).toBe("ltr");
  });
});

describe("company profile and header", () => {
  const raw = {
    name: "Honest®",
    legal_name_ar: "أونست للتجارة (اسم مؤقت)",
    legal_name_en: "Honest Trading (placeholder name)",
    address_ar: "عنوان مؤقت",
    address_en: "",
    tax_registration_no: "000-000-000",
    commercial_register_no: 12345,
    logo_url: "javascript:alert(1)",
    unknown_key: "ignored",
  };

  it("keeps only known string settings", () => {
    const p = parseCompanyProfile(raw);
    expect(p.commercial_register_no).toBe("");
    expect(p).not.toHaveProperty("unknown_key");
    expect(parseCompanyProfile(null).name).toBe("");
    expect(parseCompanyProfile(["x"]).legal_name_en).toBe("");
  });

  it("picks the document language and falls back to the other one", () => {
    const p = parseCompanyProfile(raw);
    expect(companyHeader(p, "ar").name).toBe("أونست للتجارة (اسم مؤقت)");
    expect(companyHeader(p, "en").name).toBe("Honest Trading (placeholder name)");
    expect(companyHeader(p, "en").address).toBe("عنوان مؤقت");
    expect(companyHeader(parseCompanyProfile({ name: "Honest®" }), "ar").name).toBe("Honest®");
    expect(companyHeader(p, "ar").logoUrl).toBeNull();
  });

  it("allows only https or same-origin logo URLs", () => {
    expect(safeLogoUrl("https://cdn.example.test/logo.png")).toBeNull();
    expect(safeLogoUrl("/api/export/customers")).toBeNull();
    expect(safeLogoUrl("/brand/../api/x.png")).toBeNull();
    expect(safeLogoUrl("/brand/logo.png?x=1")).toBeNull();
    expect(safeLogoUrl("/brand/logo.txt")).toBeNull();
    expect(safeLogoUrl("/brand/logo.svg")).toBe("/brand/logo.svg");
    expect(safeLogoUrl("")).toBeNull();
    expect(safeLogoUrl(null)).toBeNull();
    expect(safeLogoUrl("http://example.test/logo.png")).toBeNull();
    expect(safeLogoUrl("//evil.test/logo.png")).toBeNull();
    expect(safeLogoUrl("/\\evil.test")).toBeNull();
    expect(safeLogoUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(safeLogoUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("VAT summary", () => {
  it("groups taxable amounts and VAT by rate, highest rate first, in cents", () => {
    const lines = [
      { tax_rate_pct: "14.00", line_subtotal: "1000.00", discount: "100.00", tax_amount: "126.00" },
      { tax_rate_pct: 14, line_subtotal: 0.1, discount: 0, tax_amount: 0.01 },
      { tax_rate_pct: "0", line_subtotal: "50.00", discount: "0", tax_amount: "0" },
      { tax_rate_pct: "5", line_subtotal: "0.20", discount: "0", tax_amount: "0.01" },
    ];
    expect(vatSummary(lines)).toEqual([
      { rate: 14, taxable: 900.1, vat: 126.01 },
      { rate: 5, taxable: 0.2, vat: 0.01 },
      { rate: 0, taxable: 50, vat: 0 },
    ]);
    expect(vatSummary([])).toEqual([]);
  });
});

describe("receipts and settlement rows", () => {
  it("only confirmed payments have a receipt", () => {
    expect(hasReceipt({ status: "confirmed" })).toBe(true);
    for (const s of ["pending_verification", "bounced", "reversed"] as const) expect(hasReceipt({ status: s })).toBe(false);
  });
  it("nonZero ignores sub-cent noise", () => {
    expect(nonZero("0.00")).toBe(false);
    expect(nonZero(null)).toBe(false);
    expect(nonZero("0.01")).toBe(true);
    expect(nonZero(-5)).toBe(true);
  });
});

describe("write-off (UI gating only; Postgres decides)", () => {
  const open = { status: "partially_paid" as const, open_amount: "1000.00" };

  it("is offered to collection managers on an open invoice with nothing pending", () => {
    const finance = ctx(["finance.invoice.read", "finance.collection.manage"]);
    expect(canWriteOffInvoice(finance, open, 0)).toBe(true);
    expect(canWriteOffInvoice(finance, open, 1)).toBe(false);
    expect(canWriteOffInvoice(finance, { status: "written_off", open_amount: "0" }, 0)).toBe(false);
    expect(canWriteOffInvoice(finance, { status: "paid", open_amount: "0" }, 0)).toBe(false);
    expect(canWriteOffInvoice(ctx(["finance.invoice.read", "finance.credit_note.issue"]), open, 0)).toBe(false);
    expect(canWriteOffInvoice(ANONYMOUS_CONTEXT, open, 0)).toBe(false);
  });

  it("checks the typed amount against the open amount", () => {
    expect(checkWriteOffAmount("1000", "1000.00")).toEqual({ ok: true, amount: 1000 });
    expect(checkWriteOffAmount("٢٨٠", "1000.00")).toEqual({ ok: true, amount: 280 });
    expect(checkWriteOffAmount("1000.01", "1000.00")).toEqual({ ok: false, reason: "exceedsOpen" });
    expect(checkWriteOffAmount("0", "1000.00")).toEqual({ ok: false, reason: "invalidAmount" });
    expect(checkWriteOffAmount("1.234", "1000.00")).toEqual({ ok: false, reason: "invalidAmount" });
    expect(checkWriteOffAmount("", "1000.00")).toEqual({ ok: false, reason: "invalidAmount" });
  });

  it("validates the form input (never a total or a tax)", () => {
    const base = {
      invoice_id: "38d00000-0000-0000-0000-000000000001",
      amount: "280.50",
      reason: "clinic closed (synthetic)",
      idempotency_key: "0b6b3f4e-5f1d-4c3e-9a51-6d1e2f3a4b5c",
      locale: "ar",
    };
    expect(writeOffSchema.parse(base).amount).toBe(280.5);
    expect(writeOffSchema.safeParse({ ...base, amount: "-1" }).success).toBe(false);
    expect(writeOffSchema.safeParse({ ...base, reason: "x" }).success).toBe(false);
    expect(writeOffSchema.safeParse({ ...base, invoice_id: "nope" }).success).toBe(false);
    expect(writeOffSchema.safeParse({ ...base, idempotency_key: "short" }).success).toBe(false);
  });

  it("every error code the write-off migration raises has a translation key", () => {
    const raised = new Set([...MIGRATION.matchAll(/raise exception '([A-Z_]+):/g)].map((x) => x[1] as string));
    expect(raised.size).toBeGreaterThan(3);
    for (const code of raised) expect(FINANCE_ERROR_CODES, code).toContain(code);
  });

  it("the dispatch keeps every earlier branch and adds finance.write_off", () => {
    for (const code of [
      "sales.order.discount",
      "inventory.adjustment",
      "sales.order.cancel",
      "crm.customer.reassign",
      "field.visit.exception",
      "finance.credit_note",
      "finance.write_off",
    ]) {
      expect(DISPATCH).toContain(`when '${code}'`);
    }
  });
});
