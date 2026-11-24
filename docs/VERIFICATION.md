# Verification walkthrough — Honest OS

> Status: **In use** · Last updated: 2026-11-24 · Phase P step 8
>
> A click-through per role, about 30 minutes each, that covers the Phase P features end to end:
> setup → lead → visit → order with an offer → approval → invoice → payment → commission →
> return, plus maps, tracking, notifications and account security. Status words are those of
> `docs/TESTING.md` §4.

## How to read this page

- **URLs** start with `/ar/` (Arabic is the default). Every line works in English too: replace
  `/ar/` with `/en/`; the layout flips to left-to-right and the labels become the bold English
  ones. Lines that need English say so.
- **Clicks** give the English label in bold and the Arabic label in brackets, both copied from
  `messages/{en,ar}/*.json`. "›" means "then".
- **Status** is one of:
  - `Planned`: written here, not automated (the reason is in the line or in "What cannot be
    automated here").
  - `Tested (local, verification.spec.ts › ID)`: the Playwright test with that id passed on the
    local signed-in stack (synthetic data, mock sign-in; `docs/TESTING.md` §7).
  - `Verified`: **only the owner sets this**, after doing the line themselves (or the person they
    name) on staging and filling in the record table at the end. Nobody else changes a line to
    Verified.
- Line ids are stable: the automated test for a line carries the same id
  (`tests/e2e-local/verification.spec.ts`).

## Before you start

**Accounts** (staging; one per role, synthetic names only — owner decision A keeps real data out
of tests, screenshots and notes):

| Role | Example account | Needs |
|------|-----------------|-------|
| Owner | the owner's own login | owner flag; TOTP enrolled on `/ar/account/security` |
| Sales director | `sd.test@…` | role `sales_director` |
| Area manager | `am.test@…` | role `area_manager`, the rep below in the team (`core.employees.manager_id`) |
| Sales rep | `rep.test@…` | role `sales_rep`, base address and lead radius set on `/ar/admin/setup` |
| Finance officer | `finance.test@…` | role `finance_officer` |
| Inventory manager | `inventory.test@…` | role `inventory_manager` |
| Admin | `admin.test@…` | role `admin` |

**Data that must exist** (create it with synthetic names such as "Clinic Test 1" and phones
`+2010000000NN`; never a real clinic):

- A main warehouse with stock of at least two products, a price list with their prices, and a
  **quarantine warehouse** for returns (`/ar/admin/setup` › **Create the quarantine warehouse**,
  S-01).
- At least two customers of the test rep, one **without a phone**.
- An active owner offer or package (`/ar/offers`) for the rep's customers.
- Plan **STD-2026 activated** in `/ar/commissions/plans` (owner, MFA).
- `sales.discount.limit_mode = tiered` (it is, on staging, since `20261125000290`).
- The synthetic old-system workbook for OWN-04–08, written by:
  `pnpm tsx -e 'import("./tests/unit/legacy-synthetic.ts").then((m) => m.default.writeSyntheticWorkbook("synthetic-old-system.xlsx"))'`
  (git-ignore or delete the file afterwards). Its first customer phone is `01000000001`; where that
  phone already exists the customers dry run lists row 2 as a duplicate (OWN-06), and a copy with
  that cell changed is the "corrected workbook" of OWN-07.
- For the lead lines with a key: `GOOGLE_MAPS_SERVER_KEY` and `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`
  configured, Places API (New) enabled, a budget alert set.

**Local stack:** `pnpm e2e:local:up` builds exactly this data from `scripts/e2e-local/demo-seed.sql`
(synthetic clinics "Clinic Demo 1…26", offer `PKG-DEMO-3`, STD-2026 active, quarantine warehouse
`WH-QRN`, tiered limits). The fixture users are `owner@`, `sd@`, `am.cairo@`, `rep.cairo@`,
`finance@`, `inventory@`, `admin@honest.test`, with the per-run password from
`.cache/e2e-local/env.local`.

## 0. The owner's 30-minute staging run (do this first)

One pass through the whole business on **https://honest-os-staging.vercel.app**, in the order the
business will use it. Work in Arabic (`/ar/…`) on a computer, with a phone (390 px or the APK) for
S-04 to S-06. The detailed lines per role (sections 1–7) say the same thing click by click; each
step below names them.

**Before S-01:** you are signed in as the owner with TOTP (`/ar/account/security` says the session
is verified). Use **synthetic** test records for S-03 to S-10 ("Clinic Test 1", phone
`+2010000000NN`, the person "Rep Test"), never a real clinic. What you create here stays on staging
(ledgers are append-only); a wrong invoice is corrected by a credit note, not by deleting it.

**Status** here is the lowest status of the lines the step relies on. "Tested (local)" means the
same clicks passed on the local stack with synthetic data and mocked sign-in (`docs/TESTING.md`
§7–8); it is not Verified. Only you set Verified, in the record table at the end.

| # | Step (who) | Exact URL | What to click | What you should see | Lines | Status |
|---|------------|-----------|---------------|---------------------|-------|--------|
| S-01 | Owner setup (owner, ~4 min) | `/ar/admin/setup` | Read **Progress** (التقدم). If missing: **Create the main warehouse** (إنشاء المخزن الرئيسي) with code `WH-MAIN`; **Cover Dakahlia with Mansoura** (تغطية الدقهلية بمنطقة المنصورة); then **Create the quarantine warehouse** (إنشاء مخزن الحجر) with code `WH-QRN` (returns are received there) | **Owner setup** (إعداد المالك); Progress shows Main warehouse, Territories with coverage, People, Logins and Reps' base addresses, each done or with its count | OWN-02 | Tested (local) for the page and the quarantine form (unit `admin-setup`, one manual local run); creating them on staging: Planned |
| S-02 | Old-system workbook (owner, ~6 min) | `/ar/admin/setup/legacy-import` | **Workbook (.xlsx)** (الملف .xlsx) › your real workbook › **Upload and check** (رفع ومراجعة) › decide each negative-stock item (**Fix all to 0** (تصفير الكل) or skip) › **Start the import** › for each of the five steps in order (customers, products, prices, opening stock, opening balances): **Dry run** (تجربة), read the result, then **Commit** | Every card under **Reconciliation with the Checks sheet** (المطابقة مع ورقة المراجعة) says it matches the source (on-hand units differ only by the negative rows you chose to skip); a step opens only after the one before is committed; at the end **3. Data to complete** (٣. بيانات تحتاج استكمالاً) (customers without phone or location, items without cost) with links. No file is stored | OWN-03 to OWN-08 | Tested (local, synthetic workbook); the real import is yours |
| S-03 | Invite a rep and sign in as the rep (owner, then rep, ~4 min) | `/ar/admin/setup` › **3. People, roles and logins** (3. الأشخاص والأدوار وحسابات الدخول) | **Add a person** (إضافة شخص): name "Rep Test", **E-mail** a mailbox you control › **Add person** › on that row **Create login and role** (إنشاء حساب دخول ودور): **Role** (الدور) Sales Representative, **Territory** (المنطقة) Mansoura › **Create login and link** (إنشاء الحساب والرابط) › open the link in a private window (or on the phone). Then back as owner: **Base address** (عنوان الانطلاق) › **Type the point instead** (إدخال النقطة يدويًا) or **Find on map and save** (with the key) › **Lead radius (km)** 5 › **Save the point** | "Login created for … Send this link privately:" with a one-time link (no e-mail until SMTP is set up); the rep lands on the rep home with **Start my day** (ابدأ يومي) and the bottom bar (Today, Map, Leads, Visits, Orders); the row shows **Has a login** (له حساب دخول) and "Base set · 5 km" | ADM-08, REP-01 | Planned (the local stack has no real Supabase Auth); REP-01 Tested (local) |
| S-04 | Leads near the rep (rep, phone, ~3 min) | `/ar/leads` | Read the list; open one lead | Without the Places key: the plain notice that clinic names are not available yet and each lead as **Clinic (name not loaded)**; with the key: names, address, Google attribution, nearest first. On `/ar/leads/team` (owner) **Search now** lists a run with its estimated cost | REP-03, REP-04, REP-24, OWN-17 | Tested (local) without key; with the key: Planned |
| S-05 | Visit with check-in (rep, phone, ~4 min) | `/ar/today` then `/ar/leads/<id>` | **Start my day** (ابدأ يومي) › open a lead › **Clinic name** (اسم العيادة), **Doctor's name** (اسم الطبيب), **Governorate** (المحافظة) › **Save and check in** (حفظ وتسجيل الوصول) › allow location › **Check in at …** (تسجيل الوصول عند …) › later **Check out** | The lead becomes a prospect customer; the visit shows **in progress** with the GPS result (inside the radius, or "needs a manager's approval" without location); a pin proposal appears for the area manager (`/ar/map/proposals`) | REP-02, REP-05, AM-10, REP-23 | Tested (local) in a browser; on a real phone (APK, background tracking): Planned (`docs/TESTING.md` §6.1) |
| S-06 | Order with an offer and a free item (rep, ~4 min) | `/ar/orders/new` | **Customer** = the new prospect › an offer **Add** (إضافة) › **Search products** (ابحث في المنتجات) › **Add** a product with **Price** = **Free / bonus** (مجاني / هدية) › **Update prices** (تحديث الأسعار) › **Save and review prices** › **Submit order** | Before saving: the offer lines, the free line at 0 (**Free**, مجاني), VAT per product rate; the preview says the order needs approval because "A free item outside an offer needs a sales manager." After submit: **Pending approval** (بانتظار الموافقة) | REP-09, REP-10, REP-12 | Tested (local) in parts (offer order, free line and approval reason); this combined order: Planned |
| S-07 | Approval (owner or sales director, ~2 min) | `/ar/approvals` | **To decide** (بانتظار قرارك) › the request (its type reads in Arabic, e.g. "خصم أو ائتمان طلبية") › **Approve** (موافقة) | "This request was approved. No further decision is needed."; the order is **Approved** (معتمد); the rep gets a notification that opens the order | SD-04, OWN-14, REP-20 | Tested (local) |
| S-08 | Fulfil and invoice (inventory, then finance, ~3 min) | the order page `/ar/orders/<id>` | Inventory: **Warehouse** (المستودع) › **Reserve stock** (حجز المخزون) › **Post fulfilment** (تسجيل التنفيذ). Finance: **Issue invoice** (إصدار فاتورة) › **Issue invoice** (إصدار الفاتورة) | **Reserved**, then **Fulfilled**; invoice `INV-…` with **VAT summary** (ملخص الضريبة) per rate; the free line at 0 | INV-03, FIN-03, FIN-02 | Tested (local) |
| S-09 | Payment (rep, then finance, ~3 min) | `/ar/finance/payments/new`, then `/ar/finance/payments` | Rep: **Customer** › **Amount received (EGP)** › **Cash** (نقدًا) › **Record payment** (تسجيل الدفعة). Finance: the payment › **Confirm payment** (تأكيد الدفعة) › **Choose amounts** (تحديد المبالغ) on the invoice › **Allocate these amounts** (توزيع هذه المبالغ) | **Waiting for verification** (بانتظار التحقق), then **Confirmed** (مؤكدة) with the invoice under **Allocations** (التوزيعات); the invoice is paid or part-paid | REP-14, FIN-04 | Tested (local) |
| S-10 | Commission statement (finance, then rep, ~2 min) | `/ar/commissions/periods`, then `/ar/commissions` | Finance: **Recalculate <month>** (إعادة حساب …). Rep: read the statement | "The month was recalculated."; **Commission statement** (كشف العمولة) lists the paid invoice under **From collected cash to commission**, with **Print statement** (طباعة الكشف). Needs STD-2026 active (OWN-19) | FIN-05, REP-15, REP-21, OWN-19 | Tested (local); activating STD-2026 on staging: Planned (yours) |
| S-11 | Map and tracking day view (owner or area manager, ~3 min) | `/ar/map`, `/ar/tracking`, then `/ar/tracking/<rep>` | Map: read the pins and the list. Tracking: **Tracking health now** (حالة التتبع الآن) › the rep's name. Rep, at the end: **End my day** (أنهِ يومي) › **Yes, end my day** | Without the browser key: the map pages say the map is not available yet and still list customers and counts; with the key: Google map in Arabic with pins. Tracking lists only your team; the day page shows the day summary (start, visits, stops, end) and, with the key, the route | REP-16, AM-02, AM-03, AM-04, OWN-18 | Tested (local) without key; with the key and a real day's points: Planned |

## How to run the automated lines

**Local (all lines, writes included):**

```bash
pnpm e2e:local:up
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome pnpm e2e:local:verify
pnpm e2e:local:down
```

The writing lines run in order inside their flow and create their own records (new customer,
new orders, a corrected workbook with fresh synthetic phones), so the run can be repeated on the
same database. Failures leave Playwright's output in the git-ignored `test-results/verify/`.

**Preview (read-only, real data):** staging holds HONEST's real data (owner decision A), so only
the lines marked *read-only* below run, and nothing that could capture a page is kept.

```bash
VERIFY_BASE_URL=https://<preview>.vercel.app \
VERIFY_EMAIL=<test account> VERIFY_PASSWORD=<its password> VERIFY_ROLE=rep \
PW_CHROMIUM_PATH=… pnpm verify:preview
```

- The owner creates the test account (password sign-in) and gives it **one** role;
  `VERIFY_ROLE` names it: `owner`, `sd`, `am`, `rep`, `finance`, `inventory` or `admin`. Run once
  per role/account. Lines of other roles are skipped with the reason.
- Skipped in preview: every line that writes data or posts a file, and every line that needs the
  local demo records. Read-only lines check page loads, headings, permissions (forbidden pages)
  and navigation only, never a figure or a name.
- No screenshot, trace or video is taken; Playwright's failure page snapshot is switched off
  (`PLAYWRIGHT_NO_COPY_PROMPT`); the session cookies and Playwright's output folder live in a
  temporary folder outside the repository that is deleted when the run ends. A failing
  assertion's message is printed to the terminal only.
- Not run yet: no preview test account exists. The preview mechanics were exercised against the
  local stack (all seven roles, 38 read-only lines passed, 0 failed, nothing left behind).

Read-only lines (run in preview): OWN-01, 02, 09, 12, 15, 16 · SD-01, 02, 05, 07, 08 · AM-01, 02,
04, 05, 08, 09 · REP-01, 02, 03, 06, 15, 16, 17, 18, 19 · FIN-01, 08 · INV-01, 05, 06 · ADM-01–07.

---

## 1. Owner (about 30 minutes)

| # | URL | Clicks | Expected result | Status |
|---|-----|--------|-----------------|--------|
| OWN-01 | `/ar` | Sign in › lands on **Home** (الرئيسية) | Greeting with your name; cards **Company this month** (الشركة هذا الشهر) and **Waiting for your approval** (بانتظار موافقتك) show figures, an empty state or an error state, never a silent zero. | Tested (local, verification.spec.ts › OWN-01) |
| OWN-02 | `/ar/admin/setup` | Read the page › **Open the workbook import** (فتح استيراد الملف) | **Owner setup** (إعداد المالك) with **Progress** (التقدم): warehouse, territories, people, logins, reps' base addresses, old-system data. The link opens **Import the old-system workbook** (استيراد ملف النظام القديم). | Tested (local, verification.spec.ts › OWN-02) |
| OWN-03 | `/ar/admin/setup/legacy-import` | **Workbook (.xlsx)** (الملف (.xlsx)): choose any `.csv` › **Upload and check** (رفع ومراجعة) | Refused: "This is not an .xlsx workbook…" (هذا ليس ملف Excel بصيغة .xlsx…). Nothing is stored. | Tested (local, verification.spec.ts › OWN-03) |
| OWN-04 | same | Choose the **synthetic** workbook (see "Before you start"; never the real one) › **Upload and check** | **Reconciliation with the Checks sheet** (المطابقة مع ورقة المراجعة) cards with Match / Mismatch / For information; **What each step will load**; **Items with negative stock** (أصناف رصيدها سالب) lists "Synthetic flat end taper 882-14-10"; **Start the import** (بدء الاستيراد) is disabled with "Choose "fix to 0" or "skip" for every item with negative stock." | Tested (local, verification.spec.ts › OWN-04) |
| OWN-05 | same | **Fix all to 0** (تصفير الكل) › **Start the import** | **2. Load step by step** (٢. التحميل خطوة بخطوة): step 1 Customers **Ready for a dry run** (جاهزة للتجربة), steps 2–5 **Waiting** (في الانتظار). | Tested (local, verification.spec.ts › OWN-05) |
| OWN-06 | same | Step 1 › **Dry run** (تجربة) | Locally the synthetic first phone already belongs to a demo clinic, so: "The dry run found errors…" and **Rows with errors** (صفوف بها أخطاء) lists **Row 2** with `phone_primary` "already exists". On staging the dry run may pass; then note "passed" and go on. | Tested (local, verification.spec.ts › OWN-06) |
| OWN-07 | same | **Upload a corrected workbook for this step** (رفع ملف مصحح لهذه الخطوة) › choose the corrected file › **Replace this step's rows** (استبدال صفوف هذه الخطوة) › **Dry run** › tick "I checked the dry run. Commit … rows in one transaction." › **Commit** (اعتماد) › confirm | "Dry run passed. You can commit." (نجحت التجربة. يمكنك الاعتماد.), then step 1 **Committed** (معتمدة) and step 2 Products **Ready for a dry run**. | Tested (local, verification.spec.ts › OWN-07) |
| OWN-08 | same | Tick "Discard the steps that are not committed. Committed steps stay." › **Abandon this import** (إلغاء هذا الاستيراد) › confirm | The upload form is back; the committed customers stay in **Customers**. | Tested (local, verification.spec.ts › OWN-08) |
| OWN-09 | `/ar/offers` | Read the list › **VAT rates** (نسب الضريبة) | **Offers and packages** (العروض والباقات) lists the active offers; **VAT rates** shows each product's rate with **Set VAT** (تعيين الضريبة). | Tested (local, verification.spec.ts › OWN-09) |
| OWN-10 | `/ar/commissions/plans` › STD-2026 | Tabs **Rates in force and scheduled** (النِسَب السارية والمجدولة) › **Products without a rate** (منتجات بدون نسبة) | Implants 5 %, burs and instruments 1.5 % (decision D); grafts and membranes listed without a rate (locally: "every product has a rate today", the demo has none). | Tested (local, verification.spec.ts › OWN-10) |
| OWN-11 | `/ar/commissions/plans` › a **draft** plan | **Rate for** (النسبة لـ) = Category › pick one › **Rate (%)** (النسبة (%)) 2.5 › **Starts on** (تبدأ في) today › **Save rate** (حفظ النسبة) | "The rate was saved. It applies from its start day." On staging use a draft plan, never STD-2026, unless the owner means it. With MFA enforcement on and the session at aal1, the step-up box **Confirm it's you** appears first (see "What cannot be automated"). | Tested (local, verification.spec.ts › OWN-11) |
| OWN-12 | `/ar/admin/settings` | Tab **Sales & tax** (المبيعات والضريبة) | `sales.discount.limit_mode` = tiered, rep max 0, manager max 25 (decision B). | Tested (local, verification.spec.ts › OWN-12) |
| OWN-13 | `/ar/orders/new` | Customer › a product › **Price** (السعر) = **Discount %** (نسبة خصم) 40 › **Update prices** (تحديث الأسعار) › **Save and review prices** (حفظ ومراجعة الأسعار) › **Submit order** (إرسال الطلب) | Preview: "Within your limits: no approval needed for discounts…". Order status **Submitted** (مُرسل): the owner has no limit. | Tested (local, verification.spec.ts › OWN-13) |
| OWN-14 | the rep's 30 % order (REP-13) | **Open the approval request** (فتح طلب الموافقة) › **Approve** (موافقة) | "This request was approved. No further decision is needed."; the order is **Approved** (معتمد). Only the owner could decide it (AM-07). | Tested (local, verification.spec.ts › OWN-14) |
| OWN-15 | `/ar/reports` | Read the page | **Reports and exports** (التقارير والتصدير) with nine **Download CSV** (تنزيل CSV) buttons. Downloading one and opening it in Excel is Planned (see below). | Tested (local, verification.spec.ts › OWN-15) |
| OWN-16 | `/ar/account/security` | Read **Status** and **Your actions that need a code** | "Your account is protected and this session is verified." (after TOTP); the gated actions show as words ("Suspend users", إيقاف المستخدمين), never as codes. | Tested (local, verification.spec.ts › OWN-16) |
| OWN-17 | `/ar/leads/team` | With the Places key set: **Search now** for the test rep | A discovery run is listed under **Recent searches** with requests and estimated cost; leads appear for the rep. | Planned (needs `GOOGLE_MAPS_SERVER_KEY`) |
| OWN-18 | `/ar/map` | With the browser key set: open the map, click a pin | Google map in Arabic, clusters, info window with the clinic link; no CSP error in the console. | Planned (needs `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`) |
| OWN-19 | `/ar/commissions/plans` › STD-2026 | **Activate STD-2026** with "Assign every sales rep…" ticked | Status **Active**, reps assigned from the chosen day. | Planned (owner action on staging; the local seed activates it) |
| OWN-20 | `/ar/inventory/stock/<item>` (an item from **Items without cost** on the workbook import's **3. Data to complete**, or one you imported with an unknown cost) | On a lot marked **Cost unknown** (التكلفة غير معروفة): **Set cost** (تحديد التكلفة) › **Unit cost (EGP)** (تكلفة الوحدة (ج.م)) › **Reason** (السبب) › **Save cost** (حفظ التكلفة) | "Cost saved: … per unit." (حُفظت التكلفة: … للوحدة.); the lot now shows its cost in **Unit cost** (تكلفة الوحدة) and no **Set cost** button: a saved cost is never changed (a second try says "This lot's cost is already recorded…"). With MFA enforcement on and the session at aal1, the sheet first says it needs a code and links to **Verify on My security**. Once every unknown lot of an item has a cost, the item leaves **Items without cost**. Only the owner sees **Set cost**; the inventory manager sees the status only. | Tested (local, verification.spec.ts › OWN-20: imports its own one-line synthetic opening stock with an unknown cost, then sets it); on staging: Planned (yours) |

## 2. Sales director (about 25 minutes)

| # | URL | Clicks | Expected result | Status |
|---|-----|--------|-----------------|--------|
| SD-01 | `/ar` | Sign in | Greeting; **Team activity today** (نشاط الفريق اليوم); **Waiting for your approval** (بانتظار موافقتك) lists requests. | Tested (local, verification.spec.ts › SD-01) |
| SD-02 | `/ar/approvals` | Tabs **To decide** (بانتظار قرارك), **My requests** (طلباتي) | **Approvals** (الموافقات) inbox; each row opens its request. | Tested (local, verification.spec.ts › SD-02) |
| SD-03 | `/ar/orders/new` | Customer › a product › **Discount %** 20 › **Update prices** › **Save and review prices** › **Submit order** | Preview: no approval needed; status **Submitted**: a sales manager may give up to 25 % (decision B). | Tested (local, verification.spec.ts › SD-03) |
| SD-04 | the rep's 20 % order (REP-12) | **Open the approval request** › **Approve** | "This request was approved…"; the order is **Approved**; the rep is notified (REP-20). | Tested (local, verification.spec.ts › SD-04) |
| SD-05 | `/ar/dashboard` | Read the page | **Company overview** (نظرة عامة على الشركة): field activity, sales, collections, operations. | Tested (local, verification.spec.ts › SD-05) |
| SD-06 | the return requested in REP-22 | Return page › the **Approval** (الموافقة) link › **Approve** | The return is **Approved** (تمت الموافقة). | Tested (local, verification.spec.ts › SD-06) |
| SD-07 | `/ar/leads/team` | Read the page | **Leads by rep** (العملاء المحتملون لكل مندوب), per-rep table; without the server key: "Clinic names are not available yet…" (the owner/admin also reads which env var to set). | Tested (local, verification.spec.ts › SD-07) |
| SD-08 | `/ar/admin/setup/legacy-import` | Open the URL | **Access denied** (غير مسموح بالدخول): the workbook import is owner only. | Tested (local, verification.spec.ts › SD-08) |

## 3. Area manager (about 30 minutes)

| # | URL | Clicks | Expected result | Status |
|---|-----|--------|-----------------|--------|
| AM-01 | `/ar` | Sign in | **Team activity today**, **Team this month** (الفريق هذا الشهر). | Tested (local, verification.spec.ts › AM-01) |
| AM-02 | `/ar/tracking` | Section **Tracking health now** (حالة التتبع الآن) | Only your team's reps; day open/closed, last point and age, collector, permission, app version; **Needs attention** after 15 minutes without a point. The real-phone check is `docs/TESTING.md` §6.1 steps 2 and 8. | Tested (local, verification.spec.ts › AM-02) |
| AM-03 | `/ar/tracking` › a rep's name | Read the day page | Day summary and, without the browser key, **The map is not available yet** (الخريطة غير متاحة بعد) instead of the route map. | Tested (local, verification.spec.ts › AM-03) |
| AM-04 | `/ar/map/team` | Read the page | **Team map** (خريطة الفريق); without a key the no-key notice; reps with an open shift listed with **Open the day**. | Tested (local, verification.spec.ts › AM-04) |
| AM-05 | `/ar/map/proposals` | Read the page | **Pin proposals** (مواقع مقترحة) with **Approve as clinic pin** (اعتماده موقعًا للعيادة) and **Reject** per proposal. | Tested (local, verification.spec.ts › AM-05) |
| AM-06 | the rep's offer order (REP-09) | **Accept order** (قبول الطلب) | Status **Approved** (معتمد). | Tested (local, verification.spec.ts › AM-06) |
| AM-07 | `/ar/approvals` | **To decide** | The rep's 30 % order (REP-13) is **not** listed: above 25 % only the owner decides. | Tested (local, verification.spec.ts › AM-07) |
| AM-08 | `/ar/commissions/team` | Read the page | **Team commission** (عمولة الفريق) with the team's reps and totals. | Tested (local, verification.spec.ts › AM-08) |
| AM-09 | `/ar/planning` | Read the week | **Visit plan** (خطة الزيارات) for the week, **Add a visit**, **Generate month plan**. | Tested (local, verification.spec.ts › AM-09) |
| AM-10 | `/ar/map/proposals` | The new prospect's proposal (REP-05) › **Approve as clinic pin** | The proposal leaves the waiting list; the clinic now has a pin. | Tested (local, verification.spec.ts › AM-10) |

## 4. Sales rep (about 35 minutes; phone width for REP-01/02)

| # | URL | Clicks | Expected result | Status |
|---|-----|--------|-----------------|--------|
| REP-01 | `/ar` (phone) | Sign in | Rep home with **Start my day** (ابدأ يومي); the bottom bar **Field shortcuts** (اختصارات الميدان) has 5 items: Today, Map, Leads, Visits, Orders. | Tested (local, verification.spec.ts › REP-01) |
| REP-02 | `/ar/today` (phone) | Read the page | **My day** (يومي): **My working day** (يوم عملي) shift card, **Visits in progress** (زيارات جارية), **Today's plan** (خطة اليوم), **Leads near me** card, **Follow-ups**, **Tasks**. | Tested (local, verification.spec.ts › REP-02) |
| REP-03 | `/ar/leads` | Read the list | **Leads near me** (عملاء محتملون قريبون), nearest first. Without the server key: "Clinic names are not available yet. Ask the owner to finish the Google Maps setup." (أسماء العيادات غير متاحة بعد…) and each lead as **Clinic (name not loaded)** (عيادة (لم يُحمَّل الاسم)); Google Terms and Privacy links shown. | Tested (local, verification.spec.ts › REP-03) |
| REP-04 | `/ar/leads/<id>` | Open a lead | **First visit** (أول زيارة) form and **Save and check in** (حفظ وتسجيل الوصول). | Tested (local, verification.spec.ts › REP-04) |
| REP-05 | `/ar/leads` › a lead | **Clinic name** (اسم العيادة), **Doctor's name** (اسم الطبيب), **Governorate** (المحافظة) › **Save and check in** › **Check in at …** (تسجيل الوصول عند …) › first time: **I understand, use my location** (فهمت، استخدم موقعي) | The lead becomes a CRM **prospect**; the check-in shows "This clinic has no verified location yet…" and the fix is proposed as the clinic pin (AM-10). The full day on a real phone is §6.1 steps 3–5. | Tested (local, verification.spec.ts › REP-05) |
| REP-06 | `/ar/customers` | Chip **Phone missing** (بدون هاتف) | The chip is pressed, the URL keeps `phone=missing`, only customers without a phone remain. | Tested (local, verification.spec.ts › REP-06) |
| REP-07 | `/ar/customers/new` | **Clinic name**, **Doctor's name**, leave the phone empty, **Governorate** › **Create customer** (إنشاء العميل); if "A similar customer already exists" shows, check it is not the same clinic › **Create anyway** (إنشاء على أي حال) | Live warning "No phone entered…"; the customer page opens with **Add phone** (إضافة هاتف). | Tested (local, verification.spec.ts › REP-07) |
| REP-08 | that customer | **Add phone** › **Mobile or phone** (الموبايل أو الهاتف) `010…` › **Save phone** (حفظ الهاتف) | "Phone saved."; after reload the **Add phone** button is gone (call / WhatsApp buttons instead). | Tested (local, verification.spec.ts › REP-08) |
| REP-09 | `/ar/orders/new` | Customer › offer **Add** (إضافة) › **Update prices** › **Save and review prices** › **Submit order** | Preview: no approval (offers never need one); status **Submitted**. Continues with AM-06. | Tested (local, verification.spec.ts › REP-09) |
| REP-10 | `/ar/orders/new` | Customer › an offer › **Search products** (ابحث في المنتجات) › **Add** a product, **Price** = **Net price** (سعر صافٍ) 240, quantity 2 › another product, **Price** = **Free / bonus** (مجاني / هدية) › **Discount on the whole order** (خصم على الطلب كله) = **Percentage** (نسبة) 5 › **Update prices** | **Updated prices (not saved yet)**: the offer's lines, the bonus line **Free** (مجاني) at 0, "Prices before VAT; VAT added per product rate.", **VAT 14% on …**, "of which invoice discount", and "Submitting this order will need approval." with "A free item outside an offer needs a sales manager." | Tested (local, verification.spec.ts › REP-10) |
| REP-11 | `/ar/orders/new` | A product with **Discount %** 2 › **Calculate…** › change to 30 › **Calculate…** | 2 %: "Submitting this order will need approval." + "The manual discount is above your limit." (rep limit 0 %). 30 %: "…will need the owner's approval." | Tested (local, verification.spec.ts › REP-11) |
| REP-12 | `/ar/orders/new` | **Discount %** 20 › **Save and review prices** › **Submit order** | **Pending approval** (بانتظار الموافقة); decided by a sales manager (SD-04). | Tested (local, verification.spec.ts › REP-12) |
| REP-13 | `/ar/orders/new` | **Discount %** 30 › save › **Submit order** | **Pending approval**; only the owner can decide (AM-07, OWN-14). | Tested (local, verification.spec.ts › REP-13) |
| REP-14 | `/ar/finance/payments/new` | **Customer** (العميل) › **Amount received (EGP)** 1000 › **Cash** (نقدًا) › **Record payment** (تسجيل الدفعة) | Payment page **Waiting for verification** (بانتظار التحقق). Continues with FIN-04. | Tested (local, verification.spec.ts › REP-14) |
| REP-15 | `/ar/commissions` | Read the statement | **Commission statement** (كشف العمولة): **From collected cash to commission**, lines, **Print statement** (طباعة الكشف). | Tested (local, verification.spec.ts › REP-15) |
| REP-16 | `/ar/map` | Read the page | **Customers map** (خريطة العملاء); without the key **The map is not available yet**, the counts and the list of customers. | Tested (local, verification.spec.ts › REP-16) |
| REP-17 | `/ar/notifications` | Read the page | **Notifications** (الإشعارات), **Mark all as read**; every link opens its record. | Tested (local, verification.spec.ts › REP-17) |
| REP-18 | `/ar/admin/setup`, `/ar/commissions/plans` | Open the URLs | **Access denied** on both. | Tested (local, verification.spec.ts › REP-18) |
| REP-19 | `/ar/account/security` | Read the page | **Account security** (أمان الحساب) loads; a rep needs no code for daily work. | Tested (local, verification.spec.ts › REP-19) |
| REP-20 | `/ar/notifications` | After SD-04 | "Order approved SO-…" (تمت الموافقة على الطلبية …) links to the 20 % order. | Tested (local, verification.spec.ts › REP-20) |
| REP-21 | `/ar/commissions` | After FIN-05 | The statement lists the invoice paid in FIN-04. | Tested (local, verification.spec.ts › REP-21) |
| REP-22 | `/ar/returns/new?order=<REP-09 order>` | **Quantity** (الكمية) 1 on one line › **Reason** (السبب) › **Send for approval** (إرسال للموافقة) | "Return requested. It now waits for approval." Continues with SD-06. | Tested (local, verification.spec.ts › REP-22) |
| REP-23 | phone | The one-phone test day | `docs/TESTING.md` §6.1 steps 1–10 (Start my day, travel, check in/out, location off, End my day, day map). | Planned (real phone, APK) |
| REP-24 | `/ar/leads` | With the server key: open a lead | Names, address and Google attribution load live; distance sort; nothing stored but the place id. | Planned (needs `GOOGLE_MAPS_SERVER_KEY`) |

## 5. Finance officer (about 25 minutes)

| # | URL | Clicks | Expected result | Status |
|---|-----|--------|-----------------|--------|
| FIN-01 | `/ar` | Sign in | **Receipts today** (تحصيلات اليوم) and **Receivables aging** (أعمار المديونيات). | Tested (local, verification.spec.ts › FIN-01) |
| FIN-02 | `/ar/finance/invoices` | Open an invoice | **Invoices** list; the invoice shows its lines and **VAT summary** (ملخص الضريبة) per rate. | Tested (local, verification.spec.ts › FIN-02) |
| FIN-03 | the order of REP-09 (after INV-03) | **Issue invoice** (إصدار فاتورة) › **Issue invoice** (إصدار الفاتورة) | Invoice `INV-…` with **VAT summary** and **Print invoice** (طباعة الفاتورة). The printed A4 page is FIN-09. | Tested (local, verification.spec.ts › FIN-03) |
| FIN-04 | `/ar/finance/payments` › REP-14's payment | **Confirm payment** (تأكيد الدفعة) › **Choose amounts** (تحديد المبالغ): 1000 on the new invoice › **Allocate these amounts** (توزيع هذه المبالغ) | Status **Confirmed** (مؤكدة); **Allocations** (التوزيعات) lists the invoice. | Tested (local, verification.spec.ts › FIN-04) |
| FIN-05 | `/ar/commissions/periods` | **Recalculate <month>** (إعادة حساب …) | "The month was recalculated." The rep's statement now counts the payment (REP-21). | Tested (local, verification.spec.ts › FIN-05) |
| FIN-06 | `/ar/finance/aging` › a customer › statement | Read | **Receivables aging** buckets; the customer statement opens. | Tested (local, verification.spec.ts › FIN-06) |
| FIN-07 | the return of REP-22 (after INV-04) | **Issue the credit note** (إصدار الإشعار الدائن) | Return **Credited** (صدر إشعار دائن); the credit note is computed from the invoice lines with VAT. | Tested (local, verification.spec.ts › FIN-07) |
| FIN-08 | `/ar/admin/setup` | Open the URL | **Access denied**. | Tested (local, verification.spec.ts › FIN-08) |
| FIN-09 | an invoice › **Print invoice** | Browser print preview, ar and en | A4, right-to-left in Arabic, amount in words, VAT per rate, no cut-off columns. | Planned (visual check by a person) |

## 6. Inventory manager (about 20 minutes)

| # | URL | Clicks | Expected result | Status |
|---|-----|--------|-----------------|--------|
| INV-01 | `/ar/inventory` | Read the page | **Stock** (المخزون) table and the alert tiles, **Below reorder point** (تحت حد إعادة الطلب). | Tested (local, verification.spec.ts › INV-01) |
| INV-02 | `/ar/inventory` › a product | Read | Stock by warehouse and lot with expiry. | Tested (local, verification.spec.ts › INV-02) |
| INV-03 | the order of REP-09 (after AM-06) | **Warehouse** (المستودع) › **Reserve stock** (حجز المخزون) › **Post fulfilment** (تسجيل التنفيذ) | **Reserved** (محجوز), then **Fulfilled** (منفذ). | Tested (local, verification.spec.ts › INV-03) |
| INV-04 | the return of REP-22 (after SD-06) | **Quarantine warehouse** (مخزن الحجر) › **Receive the goods** (استلام البضاعة) | Return **Received** (تم الاستلام); the units sit in quarantine, not sellable. | Tested (local, verification.spec.ts › INV-04) |
| INV-05 | `/ar/inventory/receipts`, `/ar/inventory/movements` | Read | **Goods receipts** (استلام البضائع) list; **Stock ledger** (سجل حركة المخزون) with the fulfilment and return movements. | Tested (local, verification.spec.ts › INV-05) |
| INV-06 | `/ar/admin/setup` | Open the URL | **Access denied**. | Tested (local, verification.spec.ts › INV-06) |

## 7. Admin (about 20 minutes)

| # | URL | Clicks | Expected result | Status |
|---|-----|--------|-----------------|--------|
| ADM-01 | `/ar` | Sign in | **Your access** (صلاحياتك) summary (no role home for an admin). | Tested (local, verification.spec.ts › ADM-01) |
| ADM-02 | `/ar/admin/users` | Read | **Users** (المستخدمون) with status tabs and **Manage roles**. | Tested (local, verification.spec.ts › ADM-02) |
| ADM-03 | `/ar/admin/roles` › Sales Representative | Read | Permissions grouped by module (Customers, Finance, …) with scope and **Grant**. | Tested (local, verification.spec.ts › ADM-03) |
| ADM-04 | `/ar/admin/settings` | Read | **System settings** (إعدادات النظام); "Settings marked "Owner only"… can only be changed by an owner."; owner-only keys have no edit form. | Tested (local, verification.spec.ts › ADM-04) |
| ADM-05 | `/ar/workflow/rules` | Read | **Approval rules** (قواعد الموافقات), one row per workflow. | Tested (local, verification.spec.ts › ADM-05) |
| ADM-06 | `/ar/admin/setup`, `/ar/audit` | Open the URLs | **Access denied** on both (owner only). | Tested (local, verification.spec.ts › ADM-06) |
| ADM-07 | `/ar/admin/security` | Read | **Security events** (الأحداث الأمنية). | Tested (local, verification.spec.ts › ADM-07) |
| ADM-08 | `/ar/admin/setup` (as owner) › People | Create a login for a test person | A one-time sign-in link shown once (no SMTP yet); the person signs in with it. | Planned (needs the real Supabase Auth admin API) |

## Summary

| Role | Lines | Tested (local) | Planned | Read-only (preview) |
|------|------:|---------------:|--------:|--------------------:|
| Owner | 20 | 17 | 3 | 6 |
| Sales director | 8 | 8 | 0 | 5 |
| Area manager | 10 | 10 | 0 | 6 |
| Sales rep | 24 | 22 | 2 | 9 |
| Finance officer | 9 | 8 | 1 | 2 |
| Inventory manager | 6 | 6 | 0 | 3 |
| Admin | 8 | 7 | 1 | 7 |
| **Total** | **85** | **78** | **7** | **38** |

The 30-minute staging run (section 0) has 11 steps built from these lines: 4 rely only on lines
Tested (local) (S-02 with the synthetic workbook, S-07 to S-09); 7 also need something only
staging has (creating the warehouse, real sign-in links, Google keys, a real phone, a combined
offer-and-free-item order, the STD-2026 activation) and stay Planned for that part.

Nothing is Verified.

## What cannot be automated here

| Item | Why | Where it is checked |
|------|-----|---------------------|
| Real MFA: TOTP enrolment, step-up at aal1 with enforcement on (rate editor, legacy import, settings) | The local stack's mock auth has no factors (the owner is simply aal2); a test cannot read an authenticator app | `docs/TESTING.md` §6 "MFA" rows; the owner on staging |
| Google Maps and Places with keys (live maps, lead names, discovery runs, CSP for Maps) | No keys exist in the build environment; live calls cost money | OWN-17, OWN-18, REP-24 after the owner adds the keys |
| The Android APK: tracking with the screen off, permissions, notification | Needs a phone | `docs/TESTING.md` §6.1 (one-phone test day) and §6 "Android (device)" |
| E-mail: magic links, 8-digit codes, invites | SMTP is not configured; the mock accepts and drops e-mail | `docs/TESTING.md` §6 "Email code" once SMTP is set |
| One-time sign-in links and invites | Need the Supabase Auth admin API (the mock answers 501) | ADM-08 on staging |
| CSV export contents in Excel, A4 print look | A person judges the file and the paper | OWN-15 note, FIN-09 |
| Anything against staging that writes | Staging holds real data (decision A) | Preview mode runs read-only lines only |

## Gaps found while writing this walkthrough

- **Closed: quarantine warehouse.** Returns can only be received into a quarantine warehouse.
  `/admin/setup` now offers **Create the quarantine warehouse** (إنشاء مخزن الحجر) once a main
  warehouse exists and no active quarantine one does (same `api.create_warehouse`, kind
  `quarantine`).
- In Chromium's location emulation, a check-in while the rep's tracking watch is running never
  gets a fix unless the permission is granted after the page loads (REP-05 does so). Real phones
  keep reporting positions, so this is not seen as an app bug; §6.1 step 4 confirms it on a
  device.

## Record (filled in by the owner on staging)

**The 30-minute staging run (section 0):**

| Step | Date | Passed? | What was seen if not | Browser / phone |
|------|------|---------|----------------------|-----------------|
| S-01 owner setup | | | | |
| S-02 workbook import | | | | |
| S-03 rep invite and login | | | | |
| S-04 leads | | | | |
| S-05 visit with check-in | | | | |
| S-06 order with offer and free item | | | | |
| S-07 approval | | | | |
| S-08 fulfil and invoice | | | | |
| S-09 payment | | | | |
| S-10 commission statement | | | | |
| S-11 map and tracking day | | | | |

**Lines per role (sections 1–7):**

| Date | Role / account | Lines done | Passed | Failed (line, what was seen) | Browser / phone | By |
|------|----------------|-----------|--------|------------------------------|-----------------|----|
| | | | | | | |
| | | | | | | |
| | | | | | | |

After a line passes on staging, the owner changes its Status to `Verified (staging, <date>)`.
