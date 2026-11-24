/**
 * Import kinds and their CSV columns. Must match import._columns / import._required_columns
 * in their latest migration (20261125000110_phase_p_imports.sql for _columns; unit-tested
 * against each other by tests/unit/imports-messages.test.ts reading the migrations).
 *
 * Headers are English snake_case; the UI shows an Arabic hint for each (messages/*\/imports.json).
 * Example rows are obviously synthetic (D-03: no real personal data before legal clearance).
 */

export const IMPORT_KINDS = ["customers", "products", "customer_prices", "opening_stock", "opening_ar"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export interface KindSpec {
  columns: readonly string[];
  required: readonly string[];
  /** Synthetic example rows for the downloadable template, one value per column. */
  examples: readonly (readonly string[])[];
  /** Domain permission the commit runs under (besides admin.import.run), at scope "all". */
  permission: string | null;
}

export const KIND_SPECS: Record<ImportKind, KindSpec> = {
  customers: {
    columns: [
      "doctor_name",
      "clinic_name",
      "display_name",
      "kind",
      "specialty_code",
      "phone_primary",
      "phone_secondary",
      "email",
      "governorate_code",
      "city",
      "address_line",
      "territory_code",
      "rep_employee_no",
      "notes",
      "legacy_ref",
    ],
    required: ["phone_primary", "governorate_code"],
    examples: [
      ["Dr. Test Example", "Synthetic Dental Clinic", "", "clinic", "IMPLANTOLOGY", "01000000001", "", "test.clinic@example.test", "EG-C", "Nasr City", "1 Example Street", "", "", "Synthetic row: replace before use", "9001"],
      ["", "Sample Lab", "", "lab", "", "", "", "", "EG-GZ", "Dokki", "", "", "", "No phone yet: imported as phone missing", "9002"],
    ],
    permission: "crm.customer.create",
  },
  products: {
    columns: [
      "product_code",
      "brand_code",
      "category_code",
      "product_name_en",
      "product_name_ar",
      "lot_tracked",
      "expiry_tracked",
      "sku",
      "variant_name_en",
      "barcode",
      "uom",
      "reorder_point",
    ],
    required: ["product_code", "sku", "variant_name_en"],
    examples: [
      ["SYN-IMPLANT", "BIONER", "IMPLANT", "Synthetic Implant", "زرعة تجريبية", "yes", "yes", "SYN-IMPLANT-3510", "Synthetic 3.5x10", "", "unit", "5"],
      ["SYN-IMPLANT", "BIONER", "IMPLANT", "Synthetic Implant", "زرعة تجريبية", "yes", "yes", "SYN-IMPLANT-4010", "Synthetic 4.0x10", "", "unit", "5"],
    ],
    permission: "catalog.product.manage",
  },
  customer_prices: {
    columns: ["customer_no", "customer_phone", "price_list_code", "price_list_name", "sku", "unit_price", "min_qty", "valid_from", "customer_legacy_ref"],
    required: ["price_list_code", "sku", "unit_price"],
    examples: [
      ["", "", "DEFAULT", "Base price list", "SYN-IMPLANT-3510", "1000.00", "1", "", ""],
      ["", "01000000001", "SYN-CLINIC-LIST", "Synthetic clinic list", "SYN-IMPLANT-3510", "950.00", "1", "2026-11-01", ""],
      ["", "", "SYN-CLINIC-LIST", "", "SYN-IMPLANT-4010", "975.50", "1", "2026-11-01", "9002"],
    ],
    permission: "catalog.price.manage",
  },
  opening_stock: {
    columns: ["warehouse_code", "sku", "lot_no", "expiry_date", "quantity", "unit_cost", "cost_unknown"],
    required: ["warehouse_code", "sku", "quantity"],
    examples: [
      ["WH-EXAMPLE", "SYN-IMPLANT-3510", "SYN-LOT-001", "2029-12-31", "10", "450.00", ""],
      ["WH-EXAMPLE", "SYN-IMPLANT-4010", "SYN-LOT-002", "2030-06-30", "4", "", "yes"],
    ],
    permission: "inventory.receipt.post",
  },
  opening_ar: {
    columns: ["customer_no", "customer_phone", "amount", "customer_legacy_ref"],
    required: ["amount"],
    examples: [
      ["CUS-2026-000001", "", "1500.00", ""],
      ["", "01000000001", "-250.00", ""],
      ["", "", "320.00", "9002"],
    ],
    permission: null,
  },
};

export function isImportKind(value: unknown): value is ImportKind {
  return typeof value === "string" && (IMPORT_KINDS as readonly string[]).includes(value);
}
