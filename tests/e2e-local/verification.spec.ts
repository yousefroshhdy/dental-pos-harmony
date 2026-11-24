import { expect, test, type Page } from "@playwright/test";
import { buildSyntheticWorkbook, syntheticWorkbookBytes } from "../unit/legacy-synthetic";
import {
  button,
  chooseInCombobox,
  fillBuilder,
  orderNumber,
  previewPrices,
  saveDraft,
  statusBadge,
  submitOrder,
  txt,
} from "./verify/flows";
import { expectForbidden, heading, line, visit } from "./verify/line";
import { ar, arRe } from "./verify/messages";

/**
 * docs/VERIFICATION.md as Playwright tests: one test per line, titled with the line id.
 * Every line runs in Arabic (/ar/…) with the labels read from messages/ar (verify/messages.ts).
 *
 * Local (`pnpm e2e:local:verify`): every line, against the local stack's synthetic demo data.
 * The writing lines of one flow run in order (`serial` blocks) and create their own records, so
 * the run can be repeated on the same database.
 * Preview (`pnpm verify:preview`): only lines without `writes` / `demoData`, of VERIFY_ROLE.
 */

const noKeyMap = (page: Page) => txt(page, ar("maps.map.noKeyTitle"));
const noKeyLeads = (page: Page) => txt(page, ar("leads.list.notConfigured"));
const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
/** A synthetic Egyptian mobile in the demo range (010…), different on every run. */
const demoPhone = () => `010${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

// ============================================================================= owner
test.describe("owner", () => {
  line("OWN-01", "home shows the company figures", { as: "owner" }, async ({ page }) => {
    await visit(page, "/");
    await expect(heading(page, arRe("home.greeting"))).toBeVisible();
    await expect(heading(page, ar("home.kpis.companyMonth"))).toBeVisible();
    await expect(heading(page, ar("home.approvals.title"))).toBeVisible();
  });

  line("OWN-02", "owner setup: progress and the workbook import card", { as: "owner" }, async ({ page }) => {
    await visit(page, "/admin/setup");
    await expect(heading(page, ar("setup.title"))).toBeVisible();
    await expect(heading(page, ar("setup.progress.title"))).toBeVisible();
    await page.getByRole("link", { name: ar("legacyImport.setupCard.open") }).click();
    await expect(heading(page, ar("legacyImport.title"))).toBeVisible();
  });

  test.describe("old-system workbook (synthetic)", () => {
    test.describe.configure({ mode: "serial" });

    /** Abandons an import left open by an earlier run, so the upload form shows. */
    async function openImport(page: Page) {
      await visit(page, "/admin/setup/legacy-import");
      const abandon = page.getByRole("button", { name: ar("legacyImport.session.abandon") });
      if (await abandon.isVisible().catch(() => false)) {
        await page.getByLabel(ar("legacyImport.session.abandonCheckbox")).check();
        page.once("dialog", (d) => void d.accept());
        await abandon.click();
        await expect(page.getByRole("button", { name: ar("legacyImport.upload.analyze") })).toBeVisible();
      }
    }
    async function upload(page: Page, name: string, buffer: Buffer, mimeType: string) {
      await page.getByLabel(ar("legacyImport.upload.file")).setInputFiles({ name, mimeType, buffer });
      await page.getByRole("button", { name: ar("legacyImport.upload.analyze") }).click();
    }
    const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    /**
     * The synthetic workbook "corrected" for the customers step: new synthetic phones, account
     * numbers and names on every run, so a repeated run never meets its own earlier customers.
     */
    async function correctedWorkbook(): Promise<Buffer> {
      const wb = buildSyntheticWorkbook();
      const token = unique();
      const phones = new Map<string, string>();
      wb.getWorksheet("Customers")!.eachRow((row, n) => {
        if (n === 1) return;
        row.getCell(1).value = 700000 + Math.floor(Math.random() * 200000) + n;
        row.getCell(2).value = `${String(row.getCell(2).value)} ${token}`;
        const mobile = row.getCell(9).value;
        if (typeof mobile === "string" && /^(\+20|0)1\d{9}$/.test(mobile)) {
          if (!phones.has(mobile)) phones.set(mobile, demoPhone());
          row.getCell(9).value = phones.get(mobile)!;
        }
      });
      return Buffer.from(await syntheticWorkbookBytes(wb));
    }

    line("OWN-03", "a .csv is refused as not an .xlsx", { as: "owner", writes: true }, async ({ page }) => {
      await openImport(page);
      await upload(page, "customers.csv", Buffer.from("account_no,account_name\n1,Synthetic\n"), "text/csv");
      await expect(txt(page, ar("legacyImport.problems.not_xlsx"))).toBeVisible();
    });

    line("OWN-04", "synthetic workbook: reconciliation, negative item needs a decision", { as: "owner", writes: true }, async ({ page }) => {
      await openImport(page);
      await upload(page, "synthetic-old-system.xlsx", Buffer.from(await syntheticWorkbookBytes()), XLSX);
      await expect(heading(page, ar("legacyImport.recon.title"))).toBeVisible();
      await expect(heading(page, ar("legacyImport.negative.title"))).toBeVisible();
      await expect(txt(page, "Synthetic flat end taper 882-14-10")).toBeVisible();
      await expect(page.getByRole("button", { name: ar("legacyImport.upload.start") })).toBeDisabled();
      await expect(txt(page, ar("legacyImport.problems.decisions_incomplete"))).toBeVisible();
    });

    line("OWN-05", "fix to 0, start: step 1 ready, steps 2–5 waiting", { as: "owner", writes: true }, async ({ page }) => {
      await openImport(page);
      await upload(page, "synthetic-old-system.xlsx", Buffer.from(await syntheticWorkbookBytes()), XLSX);
      await page.getByRole("button", { name: ar("legacyImport.negative.allZero") }).click();
      await page.getByRole("button", { name: ar("legacyImport.upload.start") }).click();
      await expect(heading(page, ar("legacyImport.steps.title"))).toBeVisible();
      await expect(txt(page, ar("legacyImport.steps.states.staged"))).toBeVisible();
      await expect(page.getByText(ar("legacyImport.steps.states.locked"), { exact: true })).toHaveCount(4);
    });

    line("OWN-06", "customers dry run: a row with errors is listed by number", { as: "owner", writes: true }, async ({ page }) => {
      // The synthetic workbook's first phone (+201000000001) already belongs to a demo customer.
      await visit(page, "/admin/setup/legacy-import");
      await button(page, ar("legacyImport.steps.dryRun")).click();
      await expect(txt(page, ar("legacyImport.steps.outcome.rejected"))).toBeVisible();
      await expect(heading(page, ar("legacyImport.steps.rejectsTitle"))).toBeVisible();
      await expect(txt(page, ar("legacyImport.steps.sheetRow", { row: 2 }))).toBeVisible();
    });

    line("OWN-07", "corrected workbook for the step: dry run passes, commit, products opens", { as: "owner", writes: true }, async ({ page }) => {
      await visit(page, "/admin/setup/legacy-import");
      await page.locator("summary", { hasText: ar("legacyImport.steps.restage") }).click();
      await page.getByLabel(ar("legacyImport.steps.restage")).setInputFiles({ name: "synthetic-corrected.xlsx", mimeType: XLSX, buffer: await correctedWorkbook() });
      await button(page, ar("legacyImport.steps.restageSubmit")).click();
      await expect(txt(page, ar("legacyImport.steps.states.staged"))).toBeVisible();
      await button(page, ar("legacyImport.steps.dryRun")).click();
      await expect(txt(page, ar("legacyImport.steps.outcome.validated"))).toBeVisible();
      await page.getByLabel(arRe("legacyImport.steps.commitCheckbox")).first().check();
      page.once("dialog", (d) => void d.accept());
      await button(page, ar("legacyImport.steps.commit")).click();
      await expect(txt(page, ar("legacyImport.steps.states.committed"))).toBeVisible();
      await expect(txt(page, ar("legacyImport.steps.states.staged"))).toBeVisible();
    });

    line("OWN-08", "abandon the import; committed customers stay", { as: "owner", writes: true }, async ({ page }) => {
      await visit(page, "/admin/setup/legacy-import");
      await page.getByLabel(ar("legacyImport.session.abandonCheckbox")).check();
      page.once("dialog", (d) => void d.accept());
      await page.getByRole("button", { name: ar("legacyImport.session.abandon") }).click();
      await expect(page.getByRole("button", { name: ar("legacyImport.upload.analyze") })).toBeVisible();
    });
  });

  line("OWN-09", "offers and per-product VAT", { as: "owner" }, async ({ page, local }) => {
    await visit(page, "/offers");
    await expect(heading(page, ar("orders.offerAdmin.title"))).toBeVisible();
    if (local) await expect(txt(page, "PKG-DEMO-3")).toBeVisible();
    await page.getByRole("link", { name: ar("orders.offerAdmin.vatLink") }).first().click();
    await expect(heading(page, ar("orders.offerAdmin.vatTitle"))).toBeVisible();
  });

  line("OWN-10", "commission rate editor: rates in force and products without a rate", { as: "owner", demoData: true }, async ({ page, ids }) => {
    await visit(page, `/commissions/plans/${ids.plan}`);
    await expect(heading(page, /STD-2026/)).toBeVisible();
    await expect(heading(page, ar("commissions.plans.rulesLive"))).toBeVisible();
    await page.getByRole("tab", { name: ar("commissions.plans.unratedTitle") }).click();
    await expect(page.getByRole("heading", { level: 2, name: ar("commissions.plans.unratedTitle") })).toBeVisible();
  });

  line("OWN-11", "set a rate on a draft plan", { as: "owner", writes: true }, async ({ page }) => {
    await visit(page, "/commissions/plans");
    await page.getByRole("link", { name: /DEMO-2027/ }).first().click();
    await page.getByLabel(ar("commissions.plans.target")).selectOption("category");
    await page.getByLabel(ar("commissions.plans.targetType.category")).selectOption({ index: 1 });
    await page.getByLabel(ar("commissions.plans.rate"), { exact: true }).fill("2.5");
    await page.getByLabel(ar("commissions.plans.note")).fill(`verification ${unique()}`);
    await button(page, ar("commissions.plans.save")).click();
    await expect(txt(page, ar("commissions.messages.rateSet"))).toBeVisible();
  });

  line("OWN-12", "settings: decision-B discount limits", { as: "owner" }, async ({ page, local }) => {
    await visit(page, "/admin/settings");
    await expect(heading(page, ar("admin.settings.title"))).toBeVisible();
    await page.getByRole("tab", { name: arRe("admin.settings.groups.sales") }).click();
    await expect(txt(page, /sales\.discount\.limit_mode/)).toBeVisible();
    if (local) await expect(txt(page, /tiered/)).toBeVisible();
  });

  line("OWN-15", "reports and exports", { as: "owner" }, async ({ page }) => {
    await visit(page, "/reports");
    await expect(heading(page, ar("reports.page.title"))).toBeVisible();
    await expect(page.getByRole("button", { name: ar("reports.page.download") })).toHaveCount(9);
  });

  line("OWN-20", "set an unknown lot cost once", { as: "owner", writes: true, demoData: true }, async ({ page, ids }) => {
    // Its own unknown-cost lot on every run: one synthetic opening-stock line with cost_unknown = yes.
    const lot = `OWN20-${unique().toUpperCase()}`;
    await visit(page, "/imports?kind=opening_stock");
    await page.getByLabel(ar("imports.upload.file")).setInputFiles({
      name: "opening-stock-synthetic.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(`warehouse_code,sku,lot_no,expiry_date,quantity,unit_cost,cost_unknown\nWH-CAI,BIO-TOP-4110,${lot},,1,,yes\n`),
    });
    await button(page, ar("imports.upload.submit")).click();
    await page.waitForURL(/\/imports\/[0-9a-f-]{36}/);
    await button(page, ar("imports.batch.validate")).click();
    await expect(txt(page, ar("imports.batch.outcome.validated"))).toBeVisible();
    await page.getByLabel(arRe("imports.batch.commitCheckbox")).check();
    page.once("dialog", (d) => void d.accept());
    await button(page, ar("imports.batch.commit")).click();
    await expect(heading(page, ar("imports.batch.resultTitle"))).toBeVisible();

    await visit(page, `/inventory/stock/${ids.variant}`);
    const row = page.getByRole("row").filter({ hasText: lot });
    await expect(row.getByText(ar("inventory.lotCost.unknown"))).toBeVisible();
    await row.getByRole("button", { name: ar("inventory.lotCost.open") }).click();
    await page.getByLabel(ar("inventory.lotCost.unitCost")).fill("1234.50");
    await page.getByLabel(ar("inventory.lotCost.reason")).fill(`Synthetic supplier invoice ${unique()}`);
    await button(page, ar("inventory.lotCost.submit")).click();
    await expect(row.getByText(/1,234\.50/)).toBeVisible();
    await expect(row.getByRole("button", { name: ar("inventory.lotCost.open") })).toHaveCount(0);
    await expect(row.getByText(ar("inventory.lotCost.unknown"))).toHaveCount(0);
  });

  line("OWN-16", "account security: verified session", { as: "owner" }, async ({ page, local }) => {
    await visit(page, "/account/security");
    await expect(heading(page, ar("security.title"))).toBeVisible();
    if (local) await expect(txt(page, ar("security.status.standing.protected"))).toBeVisible();
    // The step-up list shows readable labels, not permission codes.
    await expect(txt(page, ar("permissions.label.admin_user_suspend"))).toBeVisible();
    await expect(page.getByText("admin.user.suspend", { exact: true })).toHaveCount(0);
  });
});

// ============================================================================= sales director
test.describe("sales director", () => {
  line("SD-01", "home shows team activity and approvals", { as: "sd" }, async ({ page }) => {
    await visit(page, "/");
    await expect(heading(page, arRe("home.greeting"))).toBeVisible();
    await expect(heading(page, ar("home.team.title"))).toBeVisible();
    await expect(heading(page, ar("home.approvals.title"))).toBeVisible();
  });

  line("SD-02", "approvals inbox", { as: "sd" }, async ({ page }) => {
    await visit(page, "/approvals");
    await expect(heading(page, ar("approvals.inbox.title"))).toBeVisible();
    await expect(page.getByRole("link", { name: ar("approvals.inbox.tabs.mine") })).toBeVisible();
  });

  line("SD-03", "own order at 20 %: no approval (sales manager up to 25 %)", { as: "sd", writes: true }, async ({ page, ids }) => {
    await fillBuilder(page, { customerId: ids.customer!, lines: [{ sku: "RDT-DIA-856", mode: "discount", value: "20" }] });
    const preview = await previewPrices(page);
    await expect(txt(preview, ar("orders.preview.noApproval"))).toBeVisible();
    await saveDraft(page);
    await submitOrder(page);
    await expect(statusBadge(page, "orders.status.submitted")).toBeVisible();
  });

  line("SD-05", "company dashboard", { as: "sd" }, async ({ page }) => {
    await visit(page, "/dashboard");
    await expect(heading(page, ar("dashboards.title.all"))).toBeVisible();
  });

  line("SD-07", "leads by rep without a Places key", { as: "sd" }, async ({ page, local }) => {
    await visit(page, "/leads/team");
    await expect(heading(page, ar("leads.team.title"))).toBeVisible();
    if (local) await expect(noKeyLeads(page)).toBeVisible();
  });

  line("SD-08", "the workbook import is owner only", { as: "sd" }, async ({ page }) => {
    await visit(page, "/admin/setup/legacy-import");
    await expectForbidden(page);
  });
});

// ============================================================================= area manager
test.describe("area manager", () => {
  line("AM-01", "home shows team activity", { as: "am" }, async ({ page }) => {
    await visit(page, "/");
    await expect(heading(page, ar("home.team.title"))).toBeVisible();
    await expect(heading(page, ar("home.kpis.teamMonth"))).toBeVisible();
  });

  line("AM-02", "tracking health panel lists the team", { as: "am" }, async ({ page, local }) => {
    await visit(page, "/tracking");
    await expect(heading(page, ar("tracking.team.title"))).toBeVisible();
    await expect(heading(page, arRe("tracking.health.title"))).toBeVisible();
    if (local) await expect(txt(page, /Rep Demo Cairo|مندوب تجربة القاهرة/)).toBeVisible();
  });

  line("AM-03", "a rep's day page without a map key", { as: "am", demoData: true }, async ({ page, ids }) => {
    await visit(page, `/tracking/${ids.employee}/${ids.today}`);
    await expect(noKeyMap(page)).toBeVisible();
  });

  line("AM-04", "team map without a map key", { as: "am" }, async ({ page, local }) => {
    await visit(page, "/map/team");
    await expect(heading(page, ar("maps.team.title"))).toBeVisible();
    if (local) await expect(noKeyMap(page)).toBeVisible();
  });

  line("AM-05", "pin proposals", { as: "am" }, async ({ page, local }) => {
    await visit(page, "/map/proposals");
    await expect(heading(page, ar("maps.proposals.title"))).toBeVisible();
    if (local) await expect(button(page, ar("maps.proposals.approve"))).toBeVisible();
  });

  line("AM-08", "team commission", { as: "am" }, async ({ page, local }) => {
    await visit(page, "/commissions/team");
    await expect(heading(page, ar("commissions.team.title"))).toBeVisible();
    if (local) await expect(txt(page, /Rep Demo Cairo|مندوب تجربة القاهرة/)).toBeVisible();
  });

  line("AM-09", "visit plan for the week", { as: "am" }, async ({ page }) => {
    await visit(page, "/planning");
    await expect(heading(page, ar("planning.week.title"))).toBeVisible();
  });
});

// ============================================================================= sales rep
test.describe("sales rep", () => {
  line("REP-01", "home: start my day, field bottom bar", { as: "rep", phone: true }, async ({ page }) => {
    await visit(page, "/");
    await expect(heading(page, arRe("home.greeting"))).toBeVisible();
    await expect(page.getByRole("link", { name: ar("home.rep.startDay") })).toBeVisible();
    const bar = page.getByRole("navigation", { name: ar("shell.bottomNav") });
    await expect(bar.getByRole("link")).toHaveCount(5);
  });

  line("REP-02", "today: shift card, visits, plan, leads card", { as: "rep", phone: true }, async ({ page }) => {
    await visit(page, "/today");
    await expect(heading(page, ar("field.today.title"))).toBeVisible();
    await expect(heading(page, ar("tracking.shift.title"))).toBeVisible();
    await expect(heading(page, arRe("field.today.plan"))).toBeVisible();
    await expect(heading(page, ar("field.today.leadsTitle"))).toBeVisible();
  });

  line("REP-03", "leads without a Places key", { as: "rep" }, async ({ page, local }) => {
    await visit(page, "/leads");
    await expect(heading(page, ar("leads.list.title"))).toBeVisible();
    if (local) {
      await expect(noKeyLeads(page)).toBeVisible();
      await expect(page.getByRole("link", { name: ar("leads.list.unnamed") }).first()).toBeVisible();
    }
  });

  line("REP-04", "a lead: first-visit form", { as: "rep", demoData: true }, async ({ page }) => {
    // The last lead still to visit (REP-05 converts the first one, also on repeated runs).
    await visit(page, "/leads");
    await page.getByRole("link", { name: ar("leads.list.unnamed") }).last().click();
    await expect(heading(page, ar("leads.convert.title"))).toBeVisible();
    await expect(page.getByRole("button", { name: ar("leads.convert.submit") })).toBeVisible();
  });

  test.describe("lead to prospect to clinic pin", () => {
    test.describe.configure({ mode: "serial" });
    const name = `Clinic Verify ${unique()}`;

    line("REP-05", "first visit: the lead becomes a prospect, check-in proposes the pin", { as: "rep", writes: true }, async ({ page, context }) => {
      await visit(page, "/leads");
      await page.getByRole("link", { name: ar("leads.list.unnamed") }).first().click();
      await expect(heading(page, ar("leads.convert.title"))).toBeVisible();
      await page.getByLabel(ar("leads.convert.clinic")).fill(name);
      await page.getByLabel(ar("leads.convert.doctor")).fill("د. تحقق");
      await page.getByLabel(ar("leads.convert.governorate")).selectOption("EG-C");
      await page.getByRole("button", { name: ar("leads.convert.submit") }).click();
      await page.waitForURL(/\/visits\/new\?customer=/);
      // The phone shares its location at the clinic. Granted after the page loaded: the open
      // shift's tracking watch would otherwise hold Chromium's emulated fix, so the one-off
      // check-in reading never resolves (an emulation artefact; a real GPS keeps reporting).
      await context.grantPermissions(["geolocation"]);
      await context.setGeolocation({ latitude: 30.0612, longitude: 31.3371, accuracy: 10 });
      await button(page, ar("field.checkIn.buttonFor", { name })).click();
      const consent = page.getByRole("button", { name: ar("field.consent.accept") });
      await consent.click(); // first check-in on this browser: the GPS notice
      await expect(txt(page, ar("field.checkIn.help.no_customer_location"))).toBeVisible();
    });

    line("AM-10", "area manager approves the proposed pin", { as: "am", writes: true }, async ({ page }) => {
      await visit(page, "/map/proposals");
      const card = page.getByRole("listitem").filter({ hasText: name });
      await card.getByRole("button", { name: ar("maps.proposals.approve") }).click();
      await expect(page.getByRole("listitem").filter({ hasText: name })).toHaveCount(0);
    });
  });

  line("REP-06", "customers: phone missing chip", { as: "rep" }, async ({ page }) => {
    await visit(page, "/customers");
    await expect(heading(page, ar("crm.list.title"))).toBeVisible();
    const chip = page.getByRole("button", { name: ar("crm.list.phoneMissing") });
    await chip.click();
    await expect(page).toHaveURL(/phone=missing/);
    await expect(chip).toHaveAttribute("aria-pressed", "true");
  });

  test.describe("new customer without a phone", () => {
    test.describe.configure({ mode: "serial" });
    const name = `Clinic Verify ${unique()}`;

    line("REP-07", "create without a phone: marked phone missing", { as: "rep", writes: true }, async ({ page }) => {
      await visit(page, "/customers/new");
      await page.getByLabel(ar("crm.form.clinicName")).fill(name);
      await page.getByLabel(ar("crm.form.doctorName")).fill("د. تحقق جديد");
      await expect(txt(page, ar("crm.form.phoneMissingWarning"))).toBeVisible();
      await page.getByLabel(arRe("crm.form.governorate")).selectOption("EG-C");
      await page.getByRole("button", { name: ar("crm.form.create") }).click();
      // Earlier "Clinic Verify …" customers look alike: the duplicate check may ask first.
      const anyway = page.getByRole("button", { name: ar("crm.form.createAnyway") });
      const created = page.waitForURL(/\/customers\/[0-9a-f-]{36}/);
      await Promise.race([created, anyway.waitFor().then(() => anyway.click())]);
      await created;
      await expect(heading(page, name)).toBeVisible();
      await expect(button(page, ar("crm.addPhone.open"))).toBeVisible();
    });

    line("REP-08", "add the phone on the next visit", { as: "rep", writes: true }, async ({ page }) => {
      await visit(page, `/customers?q=${encodeURIComponent(name)}`);
      await page.getByRole("link", { name: new RegExp(name) }).first().click();
      await button(page, ar("crm.addPhone.open")).click();
      await page.getByLabel(ar("crm.addPhone.label")).fill(demoPhone());
      await button(page, ar("crm.addPhone.submit")).click();
      await expect(txt(page, ar("crm.addPhone.saved"))).toBeVisible();
      await page.reload();
      await expect(page.getByRole("button", { name: ar("crm.addPhone.open") })).toHaveCount(0);
    });
  });

  line("REP-10", "order builder: offer, net price, bonus line, invoice discount, VAT", { as: "rep", demoData: true }, async ({ page, ids }) => {
    await fillBuilder(page, {
      customerId: ids.customer!,
      offers: ["PKG-DEMO-3"],
      lines: [
        { sku: "RDT-DIA-881", mode: "net", value: "240", quantity: 2 },
        { sku: "DER-MIR-05", mode: "bonus" },
      ],
      invoiceDiscountPct: "5",
    });
    const preview = await previewPrices(page);
    await expect(txt(preview, ar("orders.preview.needsApproval"))).toBeVisible();
    await expect(txt(preview, ar("orders.preview.reasonFreeItem"))).toBeVisible();
    await expect(txt(preview, ar("orders.pricing.free"))).toBeVisible();
    await expect(txt(preview, ar("orders.pricing.pricesExcludeVat"))).toBeVisible();
    await expect(txt(preview, /^ضريبة 14\s?%/)).toBeVisible();
    await expect(txt(preview, ar("orders.pricing.ofWhichInvoiceDiscount"))).toBeVisible();
    await expect(txt(preview, "PKG-DEMO-3")).toBeVisible();
  });

  line("REP-11", "decision B: 2 % needs approval, 30 % needs the owner", { as: "rep", demoData: true }, async ({ page, ids }) => {
    await fillBuilder(page, { customerId: ids.customer!, lines: [{ sku: "RDT-DIA-856", mode: "discount", value: "2" }] });
    let preview = await previewPrices(page);
    await expect(txt(preview, ar("orders.preview.needsApproval"))).toBeVisible();
    await expect(txt(preview, ar("orders.preview.reasonDiscount"))).toBeVisible();
    await page.getByLabel(ar("orders.builder.discountPct"), { exact: true }).first().fill("30");
    preview = await previewPrices(page);
    await expect(txt(preview, ar("orders.preview.needsOwner"))).toBeVisible();
  });

  line("REP-15", "commission statement", { as: "rep" }, async ({ page }) => {
    await visit(page, "/commissions");
    await expect(heading(page, ar("commissions.statement.title"))).toBeVisible();
    await expect(heading(page, ar("commissions.statement.funnelTitle"))).toBeVisible();
    await expect(page.getByRole("link", { name: ar("commissions.statement.print") })).toBeVisible();
  });

  line("REP-16", "customers map without a browser key", { as: "rep" }, async ({ page, local }) => {
    await visit(page, "/map");
    await expect(heading(page, ar("maps.customers.title"))).toBeVisible();
    if (local) await expect(noKeyMap(page)).toBeVisible();
  });

  line("REP-17", "notifications", { as: "rep" }, async ({ page }) => {
    await visit(page, "/notifications");
    await expect(heading(page, ar("approvals.notifications.title"))).toBeVisible();
  });

  line("REP-18", "owner and admin pages are forbidden", { as: "rep" }, async ({ page }) => {
    await visit(page, "/admin/setup");
    await expectForbidden(page);
    await visit(page, "/commissions/plans");
    await expectForbidden(page);
  });

  line("REP-19", "account security", { as: "rep" }, async ({ page }) => {
    await visit(page, "/account/security");
    await expect(heading(page, ar("security.title"))).toBeVisible();
  });
});

// ============================================================================= decision B: approvals by tier
test.describe("decision B: approvals by tier", () => {
  test.describe.configure({ mode: "serial" });
  let at20 = "";
  let at30 = "";

  line("REP-12", "submit 20 %: waits for a sales manager", { as: "rep", writes: true }, async ({ page, ids }) => {
    await fillBuilder(page, { customerId: ids.customer!, lines: [{ sku: "RDT-DIA-856", mode: "discount", value: "20" }] });
    at20 = await saveDraft(page);
    await submitOrder(page);
    await expect(statusBadge(page, "orders.status.pending_approval")).toBeVisible();
  });

  line("SD-04", "sales director approves the 20 % order", { as: "sd", writes: true }, async ({ page }) => {
    await visit(page, `/orders/${at20}`);
    await page.getByRole("link", { name: ar("orders.detail.openApproval") }).click();
    await button(page, ar("approvals.decide.approve")).click();
    await expect(txt(page, ar("approvals.detail.closed.approved"))).toBeVisible();
    await visit(page, `/orders/${at20}`);
    await expect(statusBadge(page, "orders.status.approved")).toBeVisible();
  });

  line("REP-20", "the rep is notified that the order was approved", { as: "rep", writes: true }, async ({ page }) => {
    await visit(page, "/notifications");
    await expect(page.locator(`a[href$="/orders/${at20}"]`).first()).toBeVisible();
  });

  line("REP-13", "submit 30 %: waits for the owner", { as: "rep", writes: true }, async ({ page, ids }) => {
    await fillBuilder(page, { customerId: ids.customer!, lines: [{ sku: "RDT-DIA-856", mode: "discount", value: "30" }] });
    at30 = await saveDraft(page);
    await submitOrder(page);
    await expect(statusBadge(page, "orders.status.pending_approval")).toBeVisible();
  });

  line("AM-07", "the 30 % order is not in the area manager's inbox", { as: "am", writes: true }, async ({ page }) => {
    const number = await orderNumber(page, at30);
    await visit(page, "/approvals");
    await expect(heading(page, ar("approvals.inbox.title"))).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(number) })).toHaveCount(0);
  });

  line("OWN-14", "the owner approves the 30 % order", { as: "owner", writes: true }, async ({ page }) => {
    await visit(page, `/orders/${at30}`);
    await page.getByRole("link", { name: ar("orders.detail.openApproval") }).click();
    await button(page, ar("approvals.decide.approve")).click();
    await expect(txt(page, ar("approvals.detail.closed.approved"))).toBeVisible();
    await visit(page, `/orders/${at30}`);
    await expect(statusBadge(page, "orders.status.approved")).toBeVisible();
  });

  line("OWN-13", "owner's own order at 40 %: no approval", { as: "owner", writes: true }, async ({ page, ids }) => {
    await fillBuilder(page, { customerId: ids.customer!, lines: [{ sku: "RDT-DIA-856", mode: "discount", value: "40" }] });
    const preview = await previewPrices(page);
    await expect(txt(preview, ar("orders.preview.noApproval"))).toBeVisible();
    await saveDraft(page);
    await submitOrder(page);
    await expect(statusBadge(page, "orders.status.submitted")).toBeVisible();
  });
});

// ============================================================================= order to cash, commission and return
test.describe("order to cash", () => {
  test.describe.configure({ mode: "serial" });
  let orderId = "";
  let invoiceNo = "";
  let paymentId = "";
  let returnId = "";

  line("REP-09", "order with an offer: saved and submitted without approval", { as: "rep", writes: true }, async ({ page, ids }) => {
    await fillBuilder(page, { customerId: ids.customer!, offers: ["PKG-DEMO-3"] });
    const preview = await previewPrices(page);
    await expect(txt(preview, ar("orders.preview.noApproval"))).toBeVisible();
    orderId = await saveDraft(page);
    await submitOrder(page);
    await expect(statusBadge(page, "orders.status.submitted")).toBeVisible();
  });

  line("AM-06", "area manager accepts the order", { as: "am", writes: true }, async ({ page }) => {
    await visit(page, `/orders/${orderId}`);
    await button(page, ar("orders.actions.approve")).click();
    await expect(statusBadge(page, "orders.status.approved")).toBeVisible();
  });

  line("INV-03", "inventory reserves and posts the fulfilment", { as: "inventory", writes: true }, async ({ page }) => {
    await visit(page, `/orders/${orderId}`);
    const warehouse = page.getByLabel(ar("orders.actions.warehouse")).filter({ visible: true }).first();
    await warehouse.selectOption({ index: 1 });
    await button(page, ar("orders.actions.reserve")).click();
    await expect(statusBadge(page, "orders.status.reserved")).toBeVisible();
    await button(page, ar("orders.actions.fulfil")).click();
    await expect(statusBadge(page, "orders.status.fulfilled")).toBeVisible();
  });

  line("FIN-03", "finance issues the invoice: VAT summary and print", { as: "finance", writes: true }, async ({ page }) => {
    await visit(page, `/orders/${orderId}`);
    await page.getByRole("link", { name: ar("orders.detail.issueInvoice") }).filter({ visible: true }).first().click();
    await button(page, ar("finance.issue.submit")).click();
    await page.waitForURL(/\/finance\/invoices\/[0-9a-f-]{36}/);
    invoiceNo = (await page.getByRole("heading", { level: 1 }).innerText()).match(/INV-\d{4}-\d{6}/)?.[0] ?? "";
    expect(invoiceNo).not.toBe("");
    await expect(heading(page, ar("finance.print.vatSummary"))).toBeVisible();
    await expect(page.getByRole("link", { name: ar("finance.print.printInvoice") })).toBeVisible();
  });

  line("REP-14", "rep records a cash payment", { as: "rep", writes: true }, async ({ page }) => {
    await visit(page, "/finance/payments/new");
    await chooseInCombobox(page, ar("finance.record.chooseCustomer"), "Clinic Demo 3");
    await page.getByLabel(ar("finance.record.amount")).fill("1000");
    await page.getByLabel(ar("finance.method.cash"), { exact: true }).check();
    await button(page, ar("finance.record.submit")).click();
    await page.waitForURL(/\/finance\/payments\/[0-9a-f-]{36}/);
    paymentId = new URL(page.url()).pathname.split("/").pop() ?? "";
    await expect(statusBadge(page, "finance.paymentStatus.pending_verification")).toBeVisible();
  });

  line("FIN-04", "finance confirms the payment and allocates it to the new invoice", { as: "finance", writes: true }, async ({ page }) => {
    await visit(page, "/finance/payments");
    await expect(page.locator(`a[href$="/finance/payments/${paymentId}"]`).first()).toBeVisible();
    await visit(page, `/finance/payments/${paymentId}`);
    await button(page, ar("finance.paymentActions.confirm")).click();
    await expect(statusBadge(page, "finance.paymentStatus.confirmed")).toBeVisible();
    await page.getByLabel(new RegExp(invoiceNo)).fill("1000");
    await button(page, ar("finance.allocate.manualSubmit")).click();
    await expect(page.getByRole("region", { name: ar("finance.payment.allocations") }).getByRole("link", { name: invoiceNo })).toBeVisible();
  });

  line("FIN-05", "finance recalculates this month's commission", { as: "finance", writes: true }, async ({ page }) => {
    await visit(page, "/commissions/periods");
    await button(page, arRe("commissions.periods.recalculateMonth")).click();
    await expect(txt(page, arRe("commissions.messages.recalculated"))).toBeVisible();
  });

  line("REP-21", "the rep's statement lists the paid invoice", { as: "rep", writes: true }, async ({ page }) => {
    await visit(page, "/commissions");
    await expect(page.getByRole("link", { name: invoiceNo }).first()).toBeVisible();
  });

  line("REP-22", "rep requests a return of one implant", { as: "rep", writes: true }, async ({ page }) => {
    await visit(page, `/returns/new?order=${orderId}`);
    await page.getByLabel(ar("returns.request.quantity")).first().fill("1");
    await page.getByLabel(ar("returns.request.reason")).first().selectOption({ index: 1 });
    await button(page, ar("returns.request.submit")).click();
    await page.waitForURL(/\/returns\/[0-9a-f-]{36}/);
    returnId = new URL(page.url()).pathname.split("/").pop() ?? "";
    await expect(txt(page, ar("returns.detail.requestedOk"))).toBeVisible();
  });

  line("SD-06", "sales director approves the return", { as: "sd", writes: true }, async ({ page }) => {
    await visit(page, `/returns/${returnId}`);
    // The return's "Approval" row links to the request (its text is the request's status).
    await page.getByRole("main").locator('a[href*="/approvals/"]').first().click();
    await button(page, ar("approvals.decide.approve")).click();
    await expect(txt(page, ar("approvals.detail.closed.approved"))).toBeVisible();
    await visit(page, `/returns/${returnId}`);
    await expect(statusBadge(page, "returns.status.approved")).toBeVisible();
  });

  line("INV-04", "inventory receives the return into quarantine", { as: "inventory", writes: true }, async ({ page }) => {
    await visit(page, `/returns/${returnId}`);
    // One quarantine warehouse is preselected; with several, "Choose…" comes first.
    const warehouse = page.getByLabel(ar("returns.receive.warehouse"));
    if ((await warehouse.locator("option").count()) > 1) await warehouse.selectOption({ index: 1 });
    await button(page, ar("returns.receive.submit")).click();
    await expect(statusBadge(page, "returns.status.received")).toBeVisible();
  });

  line("FIN-07", "finance credits the return", { as: "finance", writes: true }, async ({ page }) => {
    await visit(page, `/returns/${returnId}`);
    await button(page, ar("returns.credit.submit")).click();
    await expect(statusBadge(page, "returns.status.credited")).toBeVisible();
  });
});

// ============================================================================= finance officer
test.describe("finance officer", () => {
  line("FIN-01", "home shows receipts and aging", { as: "finance" }, async ({ page }) => {
    await visit(page, "/");
    await expect(heading(page, ar("home.receipts.title"))).toBeVisible();
    await expect(heading(page, ar("home.aging.title"))).toBeVisible();
  });

  line("FIN-02", "invoices list and an invoice with its VAT summary", { as: "finance", demoData: true }, async ({ page, ids }) => {
    await visit(page, "/finance/invoices");
    await expect(heading(page, ar("finance.invoices.title"))).toBeVisible();
    await visit(page, `/finance/invoices/${ids.invoice}`);
    await expect(heading(page, ar("finance.print.vatSummary"))).toBeVisible();
  });

  line("FIN-06", "aging and a customer statement", { as: "finance", demoData: true }, async ({ page, ids }) => {
    await visit(page, "/finance/aging");
    await expect(heading(page, ar("finance.aging.title"))).toBeVisible();
    await visit(page, `/finance/customers/${ids.customer}/statement`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  line("FIN-08", "owner setup is forbidden", { as: "finance" }, async ({ page }) => {
    await visit(page, "/admin/setup");
    await expectForbidden(page);
  });
});

// ============================================================================= inventory manager
test.describe("inventory manager", () => {
  line("INV-01", "stock list with alert tiles", { as: "inventory" }, async ({ page }) => {
    await visit(page, "/inventory");
    await expect(heading(page, ar("inventory.stock.title"))).toBeVisible();
    await expect(heading(page, ar("inventory.stock.reorderTitle"))).toBeVisible();
  });

  line("INV-02", "stock of one product by lot", { as: "inventory", demoData: true }, async ({ page, ids }) => {
    await visit(page, `/inventory/stock/${ids.variant}`);
    await expect(txt(page, "L2026A")).toBeVisible();
  });

  line("INV-05", "receipts and the stock ledger", { as: "inventory" }, async ({ page }) => {
    await visit(page, "/inventory/receipts");
    await expect(heading(page, ar("inventory.receipts.title"))).toBeVisible();
    await visit(page, "/inventory/movements");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  line("INV-06", "owner setup is forbidden", { as: "inventory" }, async ({ page }) => {
    await visit(page, "/admin/setup");
    await expectForbidden(page);
  });
});

// ============================================================================= admin
test.describe("admin", () => {
  line("ADM-01", "home shows the access summary", { as: "admin" }, async ({ page }) => {
    await visit(page, "/");
    await expect(heading(page, ar("home.yourAccess"))).toBeVisible();
  });

  line("ADM-02", "users", { as: "admin" }, async ({ page }) => {
    await visit(page, "/admin/users");
    await expect(heading(page, ar("admin.users.title"))).toBeVisible();
  });

  line("ADM-03", "a role's permissions, grouped by module", { as: "admin" }, async ({ page }) => {
    await visit(page, "/admin/roles");
    await page.getByRole("link", { name: /Sales Representative|مندوب/ }).first().click();
    await expect(heading(page, ar("admin.roles.modules.crm"))).toBeVisible();
    await expect(heading(page, ar("admin.roles.modules.finance"))).toBeVisible();
  });

  line("ADM-04", "settings: owner-only values are marked", { as: "admin" }, async ({ page }) => {
    await visit(page, "/admin/settings");
    await expect(heading(page, ar("admin.settings.title"))).toBeVisible();
    await expect(txt(page, ar("admin.settings.ownerOnlyHint"))).toBeVisible();
  });

  line("ADM-05", "approval rules", { as: "admin" }, async ({ page }) => {
    await visit(page, "/workflow/rules");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  line("ADM-06", "owner-only pages are forbidden", { as: "admin" }, async ({ page }) => {
    await visit(page, "/admin/setup");
    await expectForbidden(page);
    await visit(page, "/audit");
    await expectForbidden(page);
  });

  line("ADM-07", "security events", { as: "admin" }, async ({ page }) => {
    await visit(page, "/admin/security");
    await expect(heading(page, ar("admin.security.title"))).toBeVisible();
  });
});
