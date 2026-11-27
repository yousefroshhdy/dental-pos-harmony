import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextIntlClientProvider } from "next-intl";
import { createElement as h, type ComponentProps, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// next-intl's navigation needs the Next.js runtime; a plain anchor is enough for markup tests.
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...props }: { href: string; children: ReactNode }) => h("a", { href, ...props }, children),
}));
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import * as primitives from "@/components/ui/primitives";

const root = join(__dirname, "../../messages");
const decode = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

function render(locale: "ar" | "en", node: ReactNode): string {
  const messages = JSON.parse(readFileSync(join(root, `${locale}.json`), "utf8"));
  return decode(
    renderToString(h(NextIntlClientProvider, { locale, messages, timeZone: "Africa/Cairo" } as ComponentProps<typeof NextIntlClientProvider>, node)),
  );
}

/** Physical-direction utilities break RTL (eslint rule in eslint.config.mjs; this checks the rendered classes). */
const PHYSICAL = /class="[^"]*(?:^|\s|:)-?(?:ml|mr|pl|pr|left|right)-/;

describe("primitives.tsx keeps its pre-Phase-P exports", () => {
  it("exports the same names", () => {
    expect(Object.keys(primitives).sort()).toEqual(["Alert", "Badge", "Card", "CardTitle", "Input", "Label", "Select", "Table", "Td", "Th"]);
  });

  it("Select is still a native <select> that takes <option> children", () => {
    const html = render("ar", h(primitives.Select, { name: "status", defaultValue: "b" }, h("option", { value: "a" }, "A"), h("option", { value: "b" }, "B")));
    expect(html).toMatch(/^<select[^>]*name="status"/);
    expect(html).toContain("min-h-11");
  });

  it("Badge still takes tone, Alert still defaults to role=alert", () => {
    // Status text uses the AA text tokens (H1 UI pass: 4.2:1 → 5.9:1 on the badge tint).
    expect(render("ar", h(primitives.Badge, { tone: "danger" }, "x"))).toContain("text-danger-text");
    expect(render("ar", h(primitives.Badge, { tone: "success" }, "x"))).toContain("text-success-text");
    expect(render("ar", h(primitives.Alert, { tone: "info" }, "x"))).toMatch(/role="alert"[^>]*class="[^"]*border-primary/);
    expect(render("ar", h(primitives.Alert, { role: "status" }, "x"))).toContain('role="status"');
  });

  it("Card keeps its own padding and Table wraps a scroll container", () => {
    expect(render("ar", h(primitives.Card, null, "x"))).toContain("p-4");
    expect(render("ar", h(primitives.Table, null, h("tbody")))).toMatch(/^<div[^>]*overflow-x-auto[^>]*><table/);
  });
});

describe("tap targets and RTL", () => {
  it("buttons and inputs are at least 44 px, except the explicit small sizes", () => {
    expect(render("ar", h(Button, null, "x"))).toContain("min-h-11");
    expect(render("ar", h(Button, { size: "icon", "aria-label": "x" }))).toMatch(/min-h-11[^"]*min-w-11|min-w-11[^"]*min-h-11/);
    expect(render("ar", h(Button, { size: "lg" }, "x"))).toContain("min-h-12");
    expect(render("ar", h(Input, { name: "q" }))).toContain("min-h-11");
  });

  it("Badge accepts both the shadcn variant and the old tone", () => {
    expect(render("en", h(Badge, { variant: "outline" }, "x"))).toContain("text-foreground");
    expect(render("en", h(Badge, { tone: "warning" }, "x"))).toContain("bg-warning/20");
  });

  it("shared components render no physical left/right classes", () => {
    for (const node of [
      h(PageHeader, { title: "T", description: "D", actions: h(Button, null, "A") }),
      h(EmptyState, { title: "T", description: "D", action: h(Button, null, "A") }),
      h(FormField, { label: "L", hint: "H", error: "E", children: h(Input, null) }),
    ]) {
      expect(render("ar", node)).not.toMatch(PHYSICAL);
    }
  });
});

describe("FormField", () => {
  it("wires id, aria-invalid and aria-describedby to the control and announces the error", () => {
    const html = render("ar", h(FormField, { id: "phone", label: "الموبايل", hint: "مثال 010", error: "هذا الحقل مطلوب.", required: true, children: h(Input, { name: "phone" }) }));
    expect(html).toContain('for="phone"');
    expect(html).toMatch(/<input[^>]*id="phone"/);
    expect(html).toMatch(/<input[^>]*aria-invalid="true"/);
    expect(html).toMatch(/<input[^>]*aria-describedby="phone-error phone-hint"/);
    expect(html).toMatch(/<p id="phone-error" role="alert"[^>]*>هذا الحقل مطلوب.<\/p>/);
    expect(html).toContain('aria-required="true"');
  });

  it("without an error the control is not marked invalid", () => {
    const html = render("en", h(FormField, { id: "n", label: "Name", children: h(Input, null) }));
    expect(html).not.toContain('aria-invalid="');
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain('role="alert"');
  });
});

interface Row {
  id: string;
  name: string;
  city: string | null;
  amount: number;
}
const ROWS: Row[] = [
  { id: "1", name: "Clinic Beta (synthetic)", city: "Mansoura", amount: 200 },
  { id: "2", name: "Clinic Alpha (synthetic)", city: null, amount: 1500 },
  { id: "3", name: "Clinic Gamma (synthetic)", city: "Talkha", amount: 50 },
];
const COLUMNS: DataTableColumn<Row>[] = [
  { id: "name", header: "Name", accessor: (r) => r.name, sortable: true, searchable: true, primary: true },
  { id: "city", header: "City", accessor: (r) => r.city, searchable: true },
  { id: "amount", header: "Amount", accessor: (r) => r.amount, sortable: true, align: "end" },
];

describe("DataTable", () => {
  it("renders a table for md+ and cards for phones, with sortable headers", () => {
    const html = render("en", h(DataTable<Row>, { columns: COLUMNS, data: ROWS }));
    expect(html).toContain("hidden overflow-x-auto rounded-lg border bg-card md:block");
    expect(html).toMatch(/<ul class="space-y-2 md:hidden">/);
    expect((html.match(/Clinic Alpha \(synthetic\)/g) ?? []).length).toBe(2); // table row + card
    expect(html).toContain('type="search"');
    expect((html.match(/Sort by this column/g) ?? []).length).toBe(2); // name, amount; city is not sortable
    expect(html).toContain("—"); // empty city
    expect(html).not.toMatch(PHYSICAL);
  });

  it("paginates on the client", () => {
    const data = Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `Row ${i}`, city: null, amount: i }));
    const html = render("en", h(DataTable<Row>, { columns: COLUMNS, data, pageSize: 25 }));
    expect(html).toContain("1–25 of 30");
    expect(html).toContain("Page 1 of 2");
    expect(html).not.toContain(">Row 26<");
  });

  it("server mode shows the server's page and total, untouched", () => {
    const state = { pageIndex: 1, pageSize: 2, sorting: [{ id: "amount", desc: true }], search: "" };
    const html = render("ar", h(DataTable<Row>, { columns: COLUMNS, data: ROWS.slice(0, 2), server: { rowCount: 7, state, onStateChange: () => {} } }));
    expect(html).toContain("3–4 من 7");
    expect(html).toContain("صفحة 2 من 4");
    expect(html).toContain('aria-sort="descending"');
  });

  it("empty, loading and error states", () => {
    expect(render("ar", h(DataTable<Row>, { columns: COLUMNS, data: [] }))).toContain("لا يوجد شيء هنا بعد.");
    expect(render("en", h(DataTable<Row>, { columns: COLUMNS, data: [], empty: h("p", null, "No customers yet") }))).toContain("No customers yet");
    expect(render("en", h(DataTable<Row>, { columns: COLUMNS, data: ROWS, loading: true }))).toContain('role="status"');
    const failed = render("en", h(DataTable<Row>, { columns: COLUMNS, data: ROWS, error: h("p", { role: "alert" }, "Failed") }));
    expect(failed).toContain("Failed");
    expect(failed).not.toContain("Clinic Alpha");
  });
});
