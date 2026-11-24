import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBonusLine, PRICES_INCLUDE_VAT, vatBasisKey, vatSummary } from "@/modules/finance/print";

/** Phase P step 6 (decision C): the printed invoice states its VAT basis and leaves free lines out of the VAT summary. */
const load = (locale: string) => JSON.parse(readFileSync(join(__dirname, `../../messages/${locale}/finance.json`), "utf8")) as { print: Record<string, string> };
const MIGRATION = readFileSync(join(__dirname, "../../supabase/migrations/20261125000210_pricing_orders.sql"), "utf8");

describe("printed invoice VAT", () => {
  it("prices are printed before VAT, as the database prices them", () => {
    expect(PRICES_INCLUDE_VAT).toBe(false);
    expect(vatBasisKey()).toBe("vatBasisExclusive");
    expect(MIGRATION).toMatch(/Prices on price lists EXCLUDE VAT/);
  });

  it("a VAT-0 item next to a 14 % one gives two rows; free lines add nothing", () => {
    const lines = [
      { tax_rate_pct: "14.00", line_subtotal: "15000.00", discount: "3000.00", tax_amount: "1680.00" },
      { tax_rate_pct: "0.00", line_subtotal: "1000.00", discount: "0.00", tax_amount: "0.00" },
      { tax_rate_pct: "5.00", line_subtotal: "0.00", discount: "0.00", tax_amount: "0.00", is_bonus: true },
      { tax_rate_pct: "14.00", line_subtotal: "0.00", discount: "0.00", tax_amount: "0.00", is_bonus: true },
    ];
    expect(vatSummary(lines)).toEqual([
      { rate: 14, taxable: 12000, vat: 1680 },
      { rate: 0, taxable: 1000, vat: 0 },
    ]);
  });

  it("isBonusLine reads only an explicit true", () => {
    expect(isBonusLine({ is_bonus: true })).toBe(true);
    expect(isBonusLine({ is_bonus: false })).toBe(false);
    expect(isBonusLine({})).toBe(false);
    expect(isBonusLine({ is_bonus: null })).toBe(false);
  });

  it.each(["ar", "en"])("the VAT-basis and bonus phrases exist (%s)", (locale) => {
    const p = load(locale).print;
    for (const key of ["vatBasisExclusive", "vatBasisInclusive", "bonus"]) expect(p[key], key).toEqual(expect.any(String));
  });
});
