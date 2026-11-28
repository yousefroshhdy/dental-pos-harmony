# Honest OS user manual

> Status: **Implemented (documentation); not Verified** · Last updated: 2026-11-28 · Phase P
>
> Arabic version: [`USER_MANUAL.ar.md`](USER_MANUAL.ar.md). The click paths follow
> [`VERIFICATION.md`](VERIFICATION.md); what each role sees follows the menu and the role
> permissions as they are built. Where this manual says "(to confirm on staging)", the screen
> was not clicked through on staging yet.

## How to read this manual

- **Labels** are written in bold English with the Arabic label in brackets, exactly as the
  screens show them: **Start my day** (ابدأ يومي). The app opens in Arabic.
- **Addresses** start with `/ar/` (Arabic). For English, replace `/ar/` with `/en/`.
  "›" means "then".
- **Examples** use test names only: "Clinic Test 1", "Rep Test", phones `+2010000000NN`.
  Never type a real clinic or person into a test.
- Each role chapter has the same parts: *What you see*, *Your tasks*, *Rules that affect you*,
  *Problems and what to do*. Problems that every role can meet are in §2.9; the chapters point
  to them by number (P1, P2, …).

## Contents

1. [How Honest OS works in one page](#1-how-honest-os-works-in-one-page)
2. [Getting started (everyone)](#2-getting-started-everyone)
3. [Owner](#3-owner)
4. [Sales director](#4-sales-director)
5. [Area manager](#5-area-manager)
6. [Sales rep](#6-sales-rep)
7. [Finance officer](#7-finance-officer)
8. [Collection officer](#8-collection-officer)
9. [Inventory manager](#9-inventory-manager)
10. [Admin](#10-admin)
11. [Glossary](#11-glossary)
12. [Who to contact](#12-who-to-contact)
- [Appendix A: Technical setup (owner and admin)](#appendix-a-technical-setup-owner-and-admin)
- [Appendix B: Known limits](#appendix-b-known-limits)

---

## 1. How Honest OS works in one page

### The flow of the business

```
Lead  →  Visit  →  Customer  →  Order  →  Approval  →  Stock  →  Invoice  →  Payment  →  Commission
(rep)    (rep)     (rep)        (rep)     (manager/    (inventory) (finance)  (rep collects,  (automatic,
                                           owner)                             finance          from paid
                                                                              confirms)        invoices)
```

1. **Lead.** Honest OS finds dental clinics around each rep's base address (5 km by default)
   and lists them under **Leads near me** (عيادات قريبة).
2. **Visit.** The rep starts the working day, goes to the clinic and checks in. The phone's
   position is compared with the clinic's saved location.
3. **Customer.** At the first visit the rep records the clinic's own details; the lead becomes a
   customer at stage **Prospect** (مهتم). The check-in position is proposed as the clinic's pin
   and a manager confirms it.
4. **Order.** The rep builds the order: owner offers, discounts, a net price or free items.
   Prices, VAT and totals are always worked out by Honest OS, never typed by the rep.
5. **Approval.** If the order is within the rep's limits it is **Submitted** (مُرسل) and a
   manager accepts it. If not, it is **Pending approval** (بانتظار الموافقة) until the right
   person decides (see "Needs approval" below).
6. **Stock.** The inventory manager reserves the goods in a warehouse and posts the fulfilment.
7. **Invoice.** Finance issues the tax invoice for what was delivered.
8. **Payment.** The rep (or a collector) records the money received; finance verifies it and
   allocates it to the invoice.
9. **Commission.** When an invoice is paid, the rep earns commission on the amount without VAT.
   The monthly statement is under **My commission** (عمولتي).

Returns go the other way: requested by the rep, approved, received into a quarantine warehouse
by inventory, then credited by finance with a credit note.

### Who does which part

| Part | Who | Where |
|------|-----|-------|
| Leads, visits, customers, orders, collecting money, returns requests | Sales rep (also area manager and sales director) | **My day** (يومي), **Leads near me**, **Customers** (العملاء), **New order** (طلب جديد), **Collect payment** (تحصيل دفعة) |
| Accepting orders, approvals, pins, team tracking, planning | Area manager, sales director | **Approvals** (الموافقات), **Pin proposals** (مواقع مقترحة), **Tracking** (التتبع), **Visit plan** (خطة الزيارات) |
| Reserving, fulfilling, receiving goods and returns | Inventory manager | **Orders**, **Stock** (المخزون), **Returns to receive** (مرتجعات للاستلام) |
| Invoices, verifying and allocating payments, credit notes, write-offs, commission months | Finance officer | **Invoices** (الفواتير), **Payments** (المدفوعات), **Commission periods** (فترات العمولة) |
| Collection follow-up of overdue invoices | Collection officer, finance officer | **Collections** (التحصيل) |
| Collection visits: working day, check-in and check-out at clinics | Collection officer | **My day** (يومي), **Visits** (الزيارات) |
| Users, roles, settings, approval rules | Admin | **Admin** (الإدارة) |
| Setup, offers, VAT, commission rates, approvals above 25 %, audit | Owner | everything |

### What "needs approval" means (owner decision B)

A manual discount is any discount you give by hand: a **Discount %** (نسبة خصم), a **Net
price** (سعر صافٍ) below the list price, or a **Discount on the whole order** (خصم على الطلب
كله). Offers and packages set by the owner are never manual discounts.

| Who submits the order | Manual discount allowed without approval | Above that |
|-----------------------|-----------------------------------------|------------|
| Sales rep (and anyone who is not a sales manager) | 0 % | Up to 25 %: a sales manager in your scope decides (your area manager or the sales director). Above 25 %: only the owner decides. |
| Sales manager: area manager or sales director | Up to 25 % | Above 25 %: only the owner decides. |
| Owner | No limit | — |

Also:
- **Offers and packages** (العروض والباقات) never need approval.
- A **free item outside an offer** needs a sales manager's approval, unless the person
  submitting is a sales manager.
- An order that takes the customer **over the credit limit** goes first to finance, then to the
  discount approver if the discount is also above the limit.
- Before you submit, **Update prices** (تحديث الأسعار) tells you what will happen:
  "Within your limits: no approval needed for discounts (the credit check runs at submit).",
  "Submitting this order will need approval." or "Submitting this order will need the owner's
  approval."
- The limits (0 % and 25 %) are settings only the owner can change.

Other requests that need a decision:

| Request | Who decides by default |
|---------|------------------------|
| Order discount or credit (خصم أو ائتمان طلبية) | as in the table above; credit first by finance |
| Order cancellation after it was accepted (إلغاء طلبية) | Sales director |
| Customer return (مرتجع عميل) | Sales director |
| Visit exception (استثناء زيارة) | Area manager (own team), sales director |
| Customer reassignment (نقل عميل لمندوب آخر) | Area manager (own territory), sales director |
| Credit note (إشعار دائن) | Finance officer (a different person from the one who asked) |
| Invoice write-off (شطب فاتورة) | Finance officer (a different person) |
| Stock adjustment above the daily limit (تسوية مخزون) | Owner |
| Commission adjustment (تعديل عمولة) | A second owner: the owner who asked cannot decide it (owner decision 2026-11-28) |

Nobody can decide their own request or a request about themselves, and one person decides at
most one stage of a request. The owner can decide any request, within those two rules.

### What the owner controls

The owner holds every permission and alone can: complete the owner setup, import the old
system's data, set unknown stock costs, create offers and packages, set VAT per product, set
and activate commission rates, decide discounts above 25 %, read the audit log, change the
owner-only settings (tracking, payments, commissions, tax, security, data retention), run the
lead search and set its Google budget. At least one active owner must always remain; the owner
role cannot be changed or removed. Two owner accounts are recommended.

### Working offline

Honest OS keeps working on the phone without a connection for: check-in and check-out, visit
exception requests, new customers and customer edits, notes, follow-up tasks and marking tasks
done, order drafts, Start my day and End my day, and the location points of the day. They are
saved on the phone and sent in order when the connection returns. The sync icon at the top of
the screen shows what is waiting; **Pending sync** (في انتظار المزامنة) lists it with **Sync
now** (زامن الآن).

These need a connection: submitting an order (final prices, stock, discounts and credit are
checked then), adding offers to an order, updating prices, recording a payment, approvals and
every office screen. Offline order prices are marked **indicative** (تقديري). Items saved more
than 7 days ago are not sent automatically; review them on the sync screen. Signing out deletes
unsent items from the phone, and Honest OS warns you first.

### Authenticator code (two-step verification)

Some sensitive actions can require a 6-digit code from an authenticator app on your phone. The
company switch is **off** today ("Not yet required", غير مطلوب بعد). When the owner turns it on,
these actions need a verified session:

- Downloading any CSV export (every role that exports).
- Finance: reversing a payment, deciding a write-off, issuing a return's credit note,
  recalculating or closing a commission month.
- Inventory: releasing stock from quarantine.
- Admin: assigning roles, managing roles, suspending users, changing settings, changing approval
  rules.
- Owner: all of the above, the old-system import, prices, commission rates, setting an unknown
  lot cost and revealing hidden values in the audit log.

**My security** (أمان حسابي) shows your own list under **Your actions that need a code**
(إجراءاتك التي تحتاج إلى رمز). Set the app up there (§2.5) before the switch is turned on.

### Privacy: location during working hours only

- Your location is recorded **only between Start my day and End my day**, about every 5
  minutes. It is never collected outside an open working day. A day still open after 10 hours
  is closed automatically.
- Check-in and check-out each read your position once, when you tap the button.
- Before the first working day you read the tracking notice and tap **I have read and
  understood this notice** (قرأت هذا الإشعار وفهمته). While the day is open the header shows
  **Tracking on** (التتبع يعمل).
- You see your own data; your area manager sees the team; the sales director and the owner see
  everyone who starts a working day (owner decision 2026-11-28).
- Detailed tracking points are deleted after 90 days (the daily summary stays); visit
  positions after 12 months.
- Stops, gaps and other flags are signals for a conversation with your manager, never automatic
  penalties.
- The tracking notice is still a draft pending the company's legal review; real use waits for
  that review.

---

## 2. Getting started (everyone)

### 2.1 First sign-in

1. The owner (or admin) creates your login and sends you a **one-time sign-in link** privately
   (WhatsApp or SMS). E-mail invitations do not arrive yet, because company e-mail sending is not
   set up.
2. Open the link on your own phone or computer. You land on your home page.
3. Next time, open `/ar` and sign in on **Sign in** (تسجيل الدخول) with **Work email** (بريد
   العمل) and **Password** (كلمة المرور) › **Sign in** (دخول), or use **Email me a sign-in
   code** (أرسل لي رمز دخول بالبريد) › **Sign-in code** (رمز الدخول) › **Sign in with the code**
   (ادخل بالرمز). The e-mail options work only once company e-mail is set up; until then ask the
   owner for a new one-time link if you are signed out. How each person gets a password is to
   confirm on staging.
4. On the Android app, use the code, not the link in the e-mail: the link opens the phone's
   browser instead of the app.

If you see **Your account is not active** (حسابك غير مفعّل), your login is not linked to an
active employee or it was suspended: contact the admin.

### 2.2 Language and appearance

- In the top bar (wide screens) or in the account menu (phones), tap **English** to switch to
  English, or **العربية** to switch back. The layout flips between right-to-left and
  left-to-right.
- The account menu also has **Appearance** (المظهر): **Light** (فاتح), **Dark** (داكن) or
  **Same as the device** (حسب إعداد الجهاز).

### 2.3 Menu, sidebar and the phone bottom bar

- On a computer the menu is the sidebar on the side of the screen, grouped by department:
  **Home** (الرئيسية), **Sales & CRM** (المبيعات والعملاء), **Field** (الميدان), **Orders**
  (الطلبات), **Finance** (المالية), **Inventory** (المخزون), **Reports** (التقارير), **Admin**
  (الإدارة). **Collapse the sidebar** (طيّ الشريط الجانبي) makes it narrow.
- On a phone tap **Open the menu** (افتح القائمة): **Menu** (القائمة) lists every screen you can
  open, by department.
- You see only the screens your role may open. Each chapter below lists them.
- People who work in the field (reps, area managers, sales director, collection officers) also
  get the **Field shortcuts** (اختصارات الميدان) bar at the bottom of the phone: **Today**
  (اليوم), **Map** (الخريطة), **Leads** (عيادات قريبة), **Visits** (الزيارات), **Orders**
  (الطلبات). Each person sees only the items their role opens (a collection officer: Today, Map,
  Visits). The owner does not get it.
- Some menu entries are named for you: **My commission** (عمولتي) when you see only your own
  commission (reps), **Commissions** (العمولات) for managers, finance and the owner; **Approvals**
  (الموافقات) when you decide requests, **My requests** (طلباتي) when you only make them.
- Your **Home** (الرئيسية) page starts with your main action where your role has one (**Start my
  day**, ابدأ يومي, for reps and collection officers), then **To do now** (المطلوب الآن): a short
  list of your open work with a count on each row, open work first. Tap a row to open the list
  that holds the work. **Nothing waiting** (لا شيء بالانتظار) means that row is clear; **Couldn't
  load** (تعذّر التحميل) means the count failed (it is never shown as 0). The cards of your role
  follow; each chapter lists them in order.
- Status colours are the same on every screen: amber = waiting on someone (submitted, pending
  approval, waiting for verification); teal = under way (planned, in progress); green = finished
  well (completed, posted, paid, fulfilled, credited, verified); red = refused, missed or failed
  (rejected, missed, bounced); grey = not in anyone's queue (draft, cancelled, written off). The
  text always names the status, so the colour is only a help.

### 2.4 Notifications

The bell in the top bar shows how many notifications are unread. **Notifications** (الإشعارات)
(`/ar/notifications`) lists them; each one opens its record (an approval, an order, a task).
Filters **All** (الكل) and **Unread** (غير المقروءة); **Mark all as read** (تحديد الكل كمقروء).
You are notified, for example, when a request you made is approved or rejected, when an order is
approved, rejected or cancelled, when a customer is assigned to you or moved away, and when a
task is assigned to you.

### 2.5 Your account and security

1. Tap your name (account menu) › **My security** (أمان حسابي) (`/ar/account/security`).
2. **Status** (الحالة) shows **Company policy** (سياسة الشركة) and **This session** (هذه الجلسة).
3. To protect your account: **Set up authenticator app** (إعداد تطبيق المصادقة) › scan the QR
   code with Google Authenticator, Microsoft Authenticator or another authenticator app ›
   **6-digit code** (رمز من ٦ أرقام) › **Confirm** (تأكيد). Result: "Your authenticator app is set
   up. This session is now verified."
4. When an action asks for a code, the box **Confirm it's you** (تأكيد هويتك) appears, or a link
   **Verify on My security** (التأكيد من «أمان حسابي»). Enter the code; you return to the page you
   were on.
5. **Sign out** (تسجيل الخروج) is in the account menu (and in the top bar on wide screens). Sign
   out on shared office computers.

### 2.6 "Access denied"

**Access denied** (غير مسموح بالدخول) — "You don't have permission to open this page" — means
your role does not include that screen. It is not an error and nothing is broken. If you need
the screen for your work, ask the admin or the owner; they decide whether your role should have
it. Inside a screen, "You don't have permission to do that." (ليست لديك صلاحية للقيام بذلك.)
means the same for one action.

### 2.7 Who to ask

- Your access, login, roles: the **admin** (مسؤول النظام), or the owner.
- A customer, a visit, an order or a discount: your **area manager**, then the **sales
  director**.
- Money (invoices, payments, statements): **finance**.
- Stock and deliveries: the **inventory manager**.
- Maps, clinic names, settings marked "Owner only": the **owner**.

See §12 for the escalation order.

### 2.8 The Android app (company phones)

Reps use the Honest OS Android app on the company phone so that the working day keeps being
recorded with the screen off. IT installs it with the steps in [`mobile/README.md`](../mobile/README.md)
("Install the pilot app, step by step"). On the phone:

- Allow notifications. The permanent notification "Honest OS is recording your location for your
  working day." is what keeps tracking running.
- At the first **Start my day**, choose location **While using the app** with **Precise** on.
  The phone does not offer "Allow all the time" and it is not needed.
- Battery: Settings › Apps › Honest OS › Battery › **Unrestricted**.
- Do not swipe Honest OS away from recent apps until you end your day.

On the shift card, **Phone settings for tracking** (إعدادات الهاتف للتتبع) repeats these steps
and **Open app settings** (افتح إعدادات التطبيق) opens the right page.

### 2.9 Problems every role can meet

| # | What you see | What to do |
|---|--------------|------------|
| P1 | **Access denied** (غير مسموح بالدخول) | Your role does not include that screen (§2.6). Ask the admin or owner if you need it. |
| P2 | An action says "This action needs a code from your authenticator app." | Open **My security**, verify this session with your app (§2.5), then try again. If you have no app yet: **Set up an authenticator app** (إعداد تطبيق مصادقة). |
| P3 | **Offline** (غير متصل) in the top bar, or "Saved on this device." | Keep working; saved work is sent automatically. Check the sync icon. Submitting an order or recording a payment waits until you are online. |
| P4 | An item on **Pending sync** shows **Failed** (فشل), **Conflict** (تعارض) or **Older than 7 days** (أقدم من 7 أيام) | Open it: **Retry** (أعد المحاولة), **Send anyway** (أرسل على أي حال), **Send mine instead** (أرسل قيمي بدلًا منها) or **Discard** (تجاهل). |
| P5 | **The map is not available yet** (الخريطة غير متاحة بعد) | The owner has not finished the Google Maps setup. The lists on the page still work. |
| P6 | "Clinic names are not available yet. Ask the owner to finish the Google Maps setup." and leads shown as **Clinic (name not loaded)** (عيادة (لم يُحمَّل الاسم)) | Same: the owner's Google setup. Leads can still be opened, planned and visited. If it says the month's Google budget is used up, ask the owner. |
| P7 | A card on the home page says **This couldn't be loaded** (تعذّر تحميل هذا الجزء) | Try again later. No number is shown in its place so you never see a wrong one. If it keeps failing, give the admin the reference shown. |
| P8 | "Someone else changed this record. Reload and try again." | Reload the page; your change was not saved over theirs. |
| P9 | "Your login is not linked to an employee record." | The admin must link your login to your employee record. |

---

## 3. Owner

The owner runs the company in Honest OS and holds every permission.

### 3.1 What you see

**Home** (`/ar`), subtitle "The company today: sales, money owed, stock and the team.", cards in
this order:

| Card | What it shows | Opens |
|------|---------------|-------|
| **Setup progress** (تقدّم الإعداد) | Shown until every step of the owner setup is done: "N steps left of M before the team can start." and the first open steps. Disappears once setup is complete. | **Continue setup** (أكمِل الإعداد) → Setup |
| **To do now** (المطلوب الآن) | Requests waiting for your approval, overdue invoices, reps whose location stopped arriving, each with its count | Approvals, overdue invoices, Tracking |
| **Waiting for your approval** (بانتظار موافقتك) | Requests that need your decision | Approvals |
| **Company this month** (الشركة هذا الشهر): tiles **Booked sales** (المبيعات المسجلة), **Collected** (المحصّل), **Open AR** (الذمم), **Overdue** (المتأخر), **Alerts** (التنبيهات), **Pending** (معلقة), **Invoiced** (المفوتر), **Orders** (الطلبات) | Booked sales = value of submitted orders without VAT (orders are pipeline, not revenue). Collected = payments confirmed by finance, with VAT. Open AR = what customers owe now, with VAT. Overdue = open amount past due date. Alerts = products at or below the reorder point plus lots expiring within 90 days. Pending = approval requests waiting. Invoiced = invoices issued without VAT, minus credit notes. Orders = orders submitted. Each tile shows "Target … · %", **As of now** (حتى الآن) or **No target set** (لا يوجد مستهدف). The link **Full dashboard** (لوحة المؤشرات كاملة) on this card opens **Company overview** (نظرة عامة على الشركة). | Booked sales and Orders → Orders; Collected, Open AR, Overdue → Aging; Alerts → Stock; Pending → Approvals; Invoiced → Invoices |
| **Team activity today** (نشاط الفريق اليوم) | Visits done of planned, and orders, per person today | Tracking |
| **Receivables aging** (أعمار المديونيات) | Total owed, overdue amount, buckets **Not yet due** … **Over 90 days**, how many customers owe money | Aging |
| **Pipeline** (فرص البيع) | Open opportunities per stage (New, Qualified, Proposal, Negotiation) with count and expected value | Opportunities |

**Menu:** every screen:
- Home: Home, **Approvals**, **Notifications**.
- Sales & CRM: **Customers**, **Opportunities** (الفرص), **Catalogue** (الكتالوج),
  **Commissions** (العمولات), **Commission periods** (فترات العمولة), **Commission adjustments**
  (تسويات العمولة), **Commission rates** (نِسَب العمولة).
- Field: **My day**, **Visits**, **Tasks** (المهام), **Visit plan**, **Coverage** (التغطية),
  **Tracking**, **Customers map** (خريطة العملاء), **Team map** (خريطة الفريق), **Pin
  proposals**, **Leads near me**, **Leads by rep** (العملاء المحتملون لكل مندوب).
- Orders: **Orders**, **New order**, **Offers** (العروض والباقات), **Returns** (المرتجعات),
  **Returns to receive**, **Returns to credit** (مرتجعات لإشعار دائن).
- Finance: **Invoices**, **Payments**, **Collect payment**, **Aging** (أعمار الديون),
  **Collections**.
- Inventory: **Stock**, **Stock ledger** (سجل حركة المخزون), **Goods receipts** (استلام
  البضائع), **Transfers** (التحويلات), **Adjust stock** (تسوية المخزون).
- Reports: **Dashboard** (لوحة المؤشرات), **Reports** (التقارير).
- Admin: **Setup** (الإعداد), **Users** (المستخدمون), **Employees** (الموظفون), **Territories**
  (المناطق), **Roles & permissions** (الأدوار والصلاحيات), **Settings** (الإعدادات), **Security
  events** (أحداث الأمان), **Delegations** (التفويضات), **Escalations** (التصعيدات), **Approval
  rules** (قواعد الموافقات), **Data import** (استيراد البيانات), **Audit log** (سجل التدقيق).

You have no phone bottom bar: the owner is not a field user.

### 3.2 Your tasks

**Once, before go-live** (also in [`docs/runbooks/owner-go-live.md`](runbooks/owner-go-live.md)):

**O-1 Protect your account.** `/ar/account/security` › **Set up authenticator app** › scan ›
code › **Confirm**. Expected: "Your account is protected and this session is verified."

**O-2 Owner setup.** `/ar/admin/setup` (**Owner setup**, إعداد المالك). Read **Progress**
(التقدم), then work down the page:
1. **1. Main warehouse** (1. المخزن الرئيسي) › **Create the main warehouse** (إنشاء المخزن
   الرئيسي), code `WH-MAIN`.
2. **Quarantine warehouse for returns** (مخزن الحجر للمرتجعات) › **Create the quarantine
   warehouse** (إنشاء مخزن الحجر), code `WH-QRN`. Returns cannot be received without it.
3. **2. Territories** (2. المناطق) › **Cover Dakahlia with Mansoura** (تغطية الدقهلية بمنطقة
   المنصورة), or **Add a territory** (إضافة منطقة) › **Create territory** (إنشاء المنطقة).
4. **3. People, roles and logins** (3. الأشخاص والأدوار وحسابات الدخول) › **Add a person**
   (إضافة شخص): name "Rep Test", **E-mail** › **Add person** (إضافة الشخص). On the row: **Create
   login and role** (إنشاء حساب دخول ودور) › **Role** (الدور) (for example Sales Representative,
   مندوب مبيعات) › **Territory** (المنطقة) › **Language** (اللغة) › **Create login and link**
   (إنشاء الحساب والرابط). Expected: "Login created for … Send this link privately:" with **Copy
   link** (نسخ الرابط). Send it to that person only; it works once. The decision-B "sales
   manager" is the role **Sales Director** (مدير المبيعات) or **Area Manager** (مدير منطقة).
5. For each rep: **Base address** (عنوان الانطلاق) › type the address › **Find on map and save**
   (البحث على الخريطة والحفظ), or **Type the point instead** (إدخال النقطة يدويًا) › **Latitude**
   / **Longitude** › **Lead radius (km)** 5 › **Save the point** (حفظ النقطة). The row shows
   "Base set · 5 km". Leads are searched around this point.

**O-3 Import the old system's data.** `/ar/admin/setup` › **Open the workbook import** (فتح
استيراد الملف) (`/ar/admin/setup/legacy-import`):
1. **Workbook (.xlsx)** (الملف (.xlsx)) › choose the workbook › **Upload and check** (رفع ومراجعة).
2. Read **Reconciliation with the Checks sheet** (المطابقة مع ورقة المراجعة): every card should
   match the source.
3. **Items with negative stock** (أصناف رصيدها سالب): for each item **Fix to 0** (تصفير) or
   **Skip** (تخطٍّ) (or **Fix all to 0** / **Skip all**).
4. **Credit balances** (الأرصدة الدائنة) stay held unless you tick "Import the credit balances
   now, with the opening balances".
5. **Start the import** (بدء الاستيراد). Then, in **2. Load step by step**, for each step in
   order (Customers, Products, Base prices, Opening stock, Opening balances): **Dry run**
   (تجربة) › read the result › tick "I checked the dry run. Commit … rows in one transaction." ›
   **Commit** (اعتماد) › confirm. A step opens only after the one before is committed. A commit
   cannot be undone; corrections are reversals.
6. If a dry run finds errors: fix the workbook › **Upload a corrected workbook for this step**
   (رفع ملف مصحح لهذه الخطوة) › **Replace this step's rows** (استبدال صفوف هذه الخطوة) › dry run
   again. To stop: tick "Discard the steps that are not committed. Committed steps stay." ›
   **Abandon this import** (إلغاء هذا الاستيراد).
7. **3. Data to complete** (٣. بيانات تحتاج استكمالاً) lists customers without phone or location
   and items without cost, with links. The file itself is not stored.

Smaller CSV imports use **Data import** (`/ar/imports`): **Upload a file** (رفع ملف) › **What are
you importing?** › **CSV file** › **Upload** › check the preview › **Validate** (تحقّق) ›
**Commit**.

**O-4 Set unknown stock costs.** From **Items without a cost (cost unknown)** (أصناف بدون تكلفة (التكلفة غير معروفة)), or `/ar/inventory/stock/<item>`: on
a lot marked **Cost unknown** (التكلفة غير معروفة) › **Set cost** (تحديد التكلفة) › **Unit cost
(EGP)** › **Reason** (for example the supplier invoice) › **Save cost** (حفظ التكلفة). Expected:
"Cost saved: … per unit." A saved cost is never changed afterwards.

**O-5 Activate commissions.** `/ar/commissions/plans` › **STD-2026**:
1. Check **Rates in force and scheduled** (النِسَب السارية والمجدولة): implants 5 %, burs and
   instruments 1.5 % (decision D).
2. **Products without a rate** (منتجات بدون نسبة): bone grafts, membranes and implant parts earn
   0 until you set a rate: **Set a rate** (تحديد نسبة) › **Rate for** (النسبة لـ) ›
   **Rate (%)** › **Starts on** (تبدأ في) › **Save rate** (حفظ النسبة). Expected: "The rate was
   saved. It applies from its start day."
3. **Activate this plan** (تفعيل هذه الخطة) › **Active from** › tick "Assign every sales rep to
   this plan from that day (recommended)" › tick the confirmation › **Activate STD-2026**.
   Expected: status **Active** (مفعّلة).

Rates are kept as history: a change starts on its date and the earlier rate stays. A rate cannot
start inside a closed month. To stop a rate: tick **No rate from this day** (بدون نسبة من هذا
اليوم).

**O-6 Offers and packages.** `/ar/offers` › **New offer** (عرض جديد): **Code** (الرمز),
**Pricing** (التسعير): **One package price** (سعر باقة واحد) or **Net price per item** (سعر صافٍ
لكل صنف), **Name (English)** / **Name (Arabic)**, **Valid from** / **Valid to**, **Add an item**
(إضافة صنف) with **Quantity** and, for free goods, **Free / bonus** (مجاني / هدية); **Who can get
it** (لمن العرض): leave empty for every customer, or **Customer numbers** / **Customer tags
(tiers)** › **Save offer** (حفظ العرض). Turn it on or off with **Switch on** (تشغيل) / **Switch
off** (إيقاف). Picking an offer on an order needs no approval. Saving an offer again changes
drafts only; submitted orders keep their prices.

**O-7 VAT per product.** `/ar/offers` › **VAT rates** (نسب الضريبة) (`/ar/offers/vat`) › the
product › rate › **Set VAT** (تعيين الضريبة). 14 % is the default until the accountant decides.
Drafts take the new rate when saved; submitted orders and issued invoices keep theirs.

**O-8 Price lists and promotions.** `/ar/catalog` › **Price lists** (قوائم الأسعار) › a list ›
**Prices** (الأسعار) › **Save**. Prices are in EGP before VAT; a new price applies to orders saved
or submitted from now on. **Promotions** (الخصومات التلقائية) are automatic percentage
discounts; they cannot be edited, only ended and created again.

**Daily:**

**O-9 Decide approvals, including discounts above 25 %.** `/ar/approvals` › **To decide** (بانتظار
قرارك) › open a request › read **What is requested** (المطلوب) › **Comment** (تعليق) (required
when rejecting) › **Approve** (موافقة) or **Reject** (رفض). Expected: "Approved. The request is
complete." or "Rejected. The requester has been notified." You cannot decide a request you made,
and if you decided one stage of a two-stage request someone else decides the other.

**O-10 Read the company.** Home, then **Dashboard** (`/ar/dashboard`): **Company overview**
(نظرة عامة على الشركة) with groups **Field activity** (النشاط الميداني), **Sales** (المبيعات),
**Collections and receivables** (التحصيلات والذمم), **Operations** (العمليات), tables by
territory and by brand, **Overdue customers** (العملاء المتأخرون) and approvals waiting. Pick the
period at the top. **Targets** (المستهدفات) opens the targets page.

**Weekly:**

**O-11 Security review.** **Security events** (`/ar/admin/security`): sign-ins, role and
permission changes, settings and exports. **Users** and **Roles & permissions**: check who holds
what.

**O-12 Audit.** **Audit log** (`/ar/audit`): search by **Table** (الجدول), **Changed by**
(بواسطة), dates and **Change** (نوع التغيير). Phones, balances and locations are hidden; **Reveal
hidden values** (كشف القيم المخفية) shows them and is recorded in the security log. A record's
history shows old and new values.

**O-13 Leads and Google cost.** **Leads by rep** (`/ar/leads/team`): per rep **Leads**, **Not
visited**, **Visited**, **Converted**, **Became customers**. **Search now** (ابحث الآن) runs a new
search for a rep; **Radius (km)** › **Save radius** (حفظ النطاق); **Google cost guard** (حماية
تكلفة Google) shows today's requests and the month's estimated spend; **Recent searches** lists
each run with its estimated cost. To change the limits: **Settings** › **Field visits**.

**Monthly:**

**O-14 Reports.** **Reports** (`/ar/reports`), **Reports and exports** (التقارير والتصدير): nine
exports (orders, order lines, invoices, payments, receivables aging, visits, customers, stock,
team day summary), each with its filters and **Download CSV** (تنزيل CSV).

**O-15 Settings.** **Settings** (`/ar/admin/settings`), **System settings** (إعدادات النظام): tabs
**Company** (الشركة), **Sales & tax** (المبيعات والضريبة) (discount limits: mode tiered, rep 0,
manager 25), **Field visits** (الزيارات الميدانية), **Offline use**, **Commissions** (العمولات),
**Payments** (الدفعات), **Work-hours tracking** (تتبع ساعات العمل), **Security** (الأمان) (the
authenticator-code switch). **Change** (تغيير) › **New value** › **Reason** › **Save**; **Reset to
default** (إرجاع للافتراضي). Every change is logged with who and why. Settings marked **Owner
only** (للمالك فقط) only you can change.

**O-16 Commission adjustments.** **Commission adjustments** (`/ar/commissions/adjustments`) ›
**New adjustment** (تسوية جديدة): **Employee**, **Month**, **Type** (bonus, clawback, correction),
**Amount (EGP)**, **Reason** › **Send for approval** (إرسال للموافقة). An adjustment counts only
after a second owner approves it: you cannot decide a request you made, and no other role
decides adjustments (owner decision 2026-11-28). Until a second owner account exists, an adjustment
cannot be approved.

You can also do everything the other roles do (orders without a discount limit, invoices,
payments, stock), but the work is normally theirs.

### 3.3 Rules that affect you

- At least one active owner must remain ("At least one active owner must remain."); the owner
  role cannot be changed; only an owner edits an owner's employee record. Keep two owner
  accounts with authenticator apps.
- Auto-approving rules in **Approval rules** can be created and changed by an owner only.
- Money and stock records are never deleted: an issued invoice is corrected with a credit note,
  a payment with a reversal, stock with an adjustment, an import with reversals. A closed
  commission month never changes.
- A lot cost, once saved, is final.
- Commission adjustments are requested by an owner and approved by a second owner; until a
  second owner exists, adjustments cannot be approved (owner decision 2026-11-28, D-08).
- Offer and price changes never alter submitted orders or issued invoices.

### 3.4 Problems and what to do

- **Maps or clinic names not available** (P5, P6): finish the Google setup (Appendix A).
- **Approval request you cannot decide** ("You made this request, so someone else must decide
  it."): another owner, or the role that holds that decision, must decide it.
- **Invite e-mail never arrives:** e-mail sending is not set up; use **Create login and link**
  on the setup page and send the link yourself.
- **Lead search shows "Waiting: daily limit" or "Waiting: monthly budget"** (في الانتظار: الحد
  اليومي / الميزانية الشهرية): the Google cost guard stopped it; raise the limit in **Settings**
  or wait for the next day or month.
- **Code asked** (P2).

---

## 4. Sales director

The sales director runs sales for the whole company ("sales manager" in decision B).

### 4.1 What you see

**Home** (`/ar`), subtitle "Your team today, the pipeline and what waits for your decision.", cards
in this order:

| Card | What it shows | Opens |
|------|---------------|-------|
| **To do now** (المطلوب الآن) | Requests waiting for your approval, reps whose location stopped arriving, each with its count | Approvals, Tracking |
| **Team activity today** (نشاط الفريق اليوم) | Visits done of planned and orders, per team member today (up to 10) | Tracking |
| **Waiting for your approval** (بانتظار موافقتك) | Requests waiting for your decision | Approvals |
| **Pipeline** (فرص البيع) | Open opportunities per stage, count and expected value | Opportunities |
| **Team this month** (الفريق هذا الشهر): **Booked sales**, **Orders**, **Visits**, **Collected** | The month so far against target. For you these are company figures. The link **Full dashboard** (لوحة المؤشرات كاملة) opens the dashboard. | Orders, Orders, Visits, Payments |

**Menu:**
- Home: Home, **Approvals**, **Notifications**.
- Sales & CRM: **Customers**, **Opportunities**, **Catalogue**, **Commissions** (العمولات),
  **Commission rates** (read only).
- Field: **My day**, **Visits**, **Tasks**, **Visit plan**, **Coverage**, **Tracking**,
  **Customers map**, **Team map**, **Pin proposals**, **Leads near me**, **Leads by rep**.
- Orders: **Orders**, **New order**, **Offers**, **Returns**.
- Finance: **Invoices**, **Payments**, **Collect payment**.
- Inventory: **Stock** (sellable stock you can promise).
- Reports: **Dashboard**, **Reports**.
- Admin: **Users** (your team), **Employees**, **Delegations**, **Escalations**.
- Phone bottom bar: Today, Map, Leads, Visits, Orders.

**You don't see:** setup, import, settings, audit, roles, approval rules (owner and admin);
aging, collections, commission periods (finance); goods receipts, transfers and adjustments
(inventory); offer and VAT editing and rate editing (owner).

### 4.2 Your tasks

**Daily:**

**SD-1 Decide approvals.** `/ar/approvals` › **To decide** › open › **Approve** or **Reject**
(with a comment). You decide: order discounts up to 25 % and free items outside offers, customer
returns, order cancellations, visit exceptions and customer reassignments, company-wide. Above
25 % the request goes to the owner, not to you.

**SD-2 Accept submitted orders.** `/ar/orders` › filter **Awaiting decision** (بانتظار القرار) ›
an order **Submitted** › **Accept order** (قبول الطلب) or **Reject…** (رفض…) › **Reason** ›
**Reject order**. Expected: **Approved** (معتمد). You cannot accept your own order. You may also
cancel a submitted order: **Cancel order…** (إلغاء الطلب…) › **Cancel order**.

**SD-3 Approve returns.** Return page (from Approvals or **Returns**) › **Approval** (الموافقة) ›
**Approve**. Expected: the return is **Approved** (تمت الموافقة); inventory receives it next.

**SD-4 Pin proposals.** `/ar/map/proposals` › **Waiting** (بانتظار القرار) › **Approve as clinic
pin** (اعتماده موقعًا للعيادة), or **Reject** (رفض) › **Reason for rejecting** › **Reject**.
Expected: "Done. The decision is saved." A position that is not accurate enough cannot become
the pin.

**SD-5 Company tracking.** `/ar/tracking` (**Field tracking**, التتبع الميداني): **Tracking health
now** (حالة التتبع الآن) shows each rep's **Day** (open/closed), **Last point**, **Collected by**,
**Location permission**, **App version**, **Battery saver**; **Needs attention** (يحتاج متابعة)
after 15 minutes without a point. Tap a name for the day page (route, stops, gaps, visits).
**Team map** (`/ar/map/team`) shows where reps on an open day were last seen. You see the whole
company: every rep and collection officer who starts a working day, also those outside your
reporting line (owner decision 2026-11-28). **Export day summary (CSV)** downloads the day (code
when enforced).

**Weekly:**

**SD-6 Dashboard and targets.** `/ar/dashboard`: **Company overview** with territory and brand
tables, **Overdue customers** and **Waiting for your approval**; open a name in the team table
to see one person. **Targets** (`/ar/dashboard/targets`) sets monthly targets per role or
employee.

**SD-7 Leads by rep.** `/ar/leads/team`: who visits their leads and how many convert. To move one
lead: lead page › **Reassign** (نقل إلى مندوب آخر) › **Move to** › **Reason** › **Reassign
lead**. To move all open leads of a rep: **Move a rep's open leads** › **From** / **To** /
**Reason** › **Move leads**.

**SD-8 Coverage and plans.** As the area manager (AM-5), for every team.

**SD-9 Reports.** `/ar/reports`: orders, order lines, invoices, payments, visits, customers,
stock and team day summary › **Download CSV** (needs a code when enforced).

**Monthly:**

**SD-10 Commission.** **Commissions** (العمولات) › **Team summary** (ملخص الفريق) (`/ar/commissions/team`)
for each rep's month. **Commission rates** shows the rates; only the owner changes them.

**SD-11 Team access.** **Users** (`/ar/admin/users`) › a person › **Manage roles** (إدارة الأدوار) ›
**Grant a role** (منح دور) › **Grant role** or **Revoke** (سحب). You can only grant roles whose
permissions you hold yourself, within your team; it needs a code when enforced.

**SD-12 Delegations.** Before a holiday: `/ar/workflow/delegations` › **New delegation** (تفويض
جديد) › **On behalf of** (Me or a team member) › **Delegate** (a colleague) › **From** / **Until**
(at most 90 days) › **Workflows** (none = all) › **Delegate** (تفويض). **End now** (إنهاء الآن)
stops it early.

You also do field work like a rep (§6): start your day, visits, orders (up to 25 % manual
discount without approval), payments and returns.

### 4.3 Rules that affect you

- Manual discount up to 25 % without approval; above it the owner decides (decision B).
- Tracking: you see every person's working day across the company; use it for conversations, never
  as an automatic penalty.
- You cannot decide your own requests or requests about yourself.
- You have no credit-limit authority by default: orders over the credit limit go to finance.
- Delegations last at most 90 days.

### 4.4 Problems and what to do

- **A request is not in To decide:** it may be above 25 % (owner), outside your scope, or yours.
  The request page says why ("This request is above your approval limit…").
- Also P1–P8.

---

## 5. Area manager

The area manager leads a team of reps in a territory ("sales manager" in decision B, for the
team).

### 5.1 What you see

**Home** (`/ar`): the same cards as the sales director (§4.1), in the same order, for your team:
**To do now** (requests waiting for your approval, reps whose location stopped arriving), **Team
activity today**, **Waiting for your approval**, **Pipeline**, **Team this month** with **Full
dashboard**.

**Menu:**
- Home: Home, **Approvals**, **Notifications**.
- Sales & CRM: **Customers** (your territory), **Opportunities**, **Catalogue**, **Commissions**
  (العمولات).
- Field: **My day**, **Visits**, **Tasks**, **Visit plan**, **Coverage**, **Tracking**,
  **Customers map**, **Team map**, **Pin proposals**, **Leads near me**, **Leads by rep**.
- Orders: **Orders**, **New order**, **Offers**, **Returns**.
- Finance: **Invoices**, **Payments**, **Collect payment**.
- Inventory: **Stock**.
- Reports: **Dashboard**, **Reports**.
- Admin: **Employees** (your team), **Delegations**, **Escalations**.
- Phone bottom bar: Today, Map, Leads, Visits, Orders.

**You don't see:** users and roles, settings, setup, audit (admin and owner); commission rates,
periods and adjustments; aging and collections; goods receipts, transfers, adjustments; customers
outside your territory.

### 5.2 Your tasks

**Daily (morning):**

**AM-1 Approvals inbox.** `/ar/approvals` › **To decide** › open › **Approve** / **Reject** (with a
comment). You decide for your team: manual discounts up to 25 % and free items outside an offer,
visit exceptions (the distance, GPS accuracy and the rep's reason are shown) and customer
reassignments in your territory. Requests above 25 % go to the owner and do not appear for you.

**AM-2 Accept your team's orders.** `/ar/orders` › **Awaiting decision** › a **Submitted** order
› **Accept order** (قبول الطلب). Expected: **Approved** (معتمد). Reject with **Reject…** and a
reason. You cannot accept your own order.

**AM-3 Pin proposals.** `/ar/map/proposals` › **Approve as clinic pin** or **Reject** with a
reason (as SD-4).

**AM-4 Team tracking and health.** `/ar/tracking` (your team only): **Tracking health now** first (reps with
**Needs attention** come first: check the phone's location permission, battery saver, the Honest
OS notification and the network), then the team table (**On shift**, **Shift time**, **Visits**,
**Visit time**, **Idle stops**, **Gaps**, **Distance**); **To review** (للمراجعة) filters the
flagged reps. **Open the day of …** shows the day; **Team map** shows reps on an open day.
**Export day summary (CSV)** downloads the day (code when enforced).

**Weekly:**

**AM-5 Planning coverage.** `/ar/planning` (**Visit plan**, خطة الزيارات) › **Plan for** (الخطة
لـ) › a rep › **Show**:
- **Add a visit** (إضافة زيارة) › **Customer** › **Day** › **Add to plan** (أضف إلى الخطة). At most
  8 planned visits a day, working days Sunday–Thursday.
- **Generate month plan** (إنشاء خطة الشهر) › **Month** › **Propose** (اقترح) › select ›
  **Save N visits**. Nothing is saved until you save.
- `/ar/planning/coverage` (**Coverage**): **Overdue** (المتأخرون) customers first › **Plan a
  visit** (خطط زيارة). Change a customer's **Visit class** (فئة الزيارة) (A weekly, B every 2 weeks,
  C monthly) › **Save class** (حفظ الفئة).

**AM-6 Leads of the team.** `/ar/leads/team` (as SD-7, for your team).

**AM-7 Team commission.** `/ar/commissions/team` (**Team commission**, عمولة الفريق).

**AM-8 Customer reassignment.** Customer page › **Request reassignment** (طلب نقل العميل) › **New
representative** › **Reason** › **Send for approval** (إرسال للموافقة). The customer stays with the
current rep until approved.

**AM-9 Dashboard.** `/ar/dashboard` (**Team performance**, أداء الفريق): team table and **Overdue
customers**.

**AM-10 Delegations.** Your own approvals while you are away (as SD-12).

You also do field work like a rep (§6), including orders with up to 25 % manual discount
without approval, collecting payments and requesting returns for your team. You cannot request a
visit exception yourself: the visit page says "This visit needs an exception to count. Ask your
manager."

### 5.3 Rules that affect you

- Decisions only for your team and territory; up to 25 % discount; above it the owner.
- You cannot approve credit-limit breaches (finance does).
- Flags in tracking are hints for a conversation, never automatic penalties.

### 5.4 Problems and what to do

- **The rep's 30 % order is not in my inbox:** correct; above 25 % only the owner decides.
- **"Needs attention" stays on:** the phone sends no points; ask the rep to open Honest OS, check
  location and battery settings (§2.8), and keep the app in recent apps.
- **A proposal cannot be approved** ("This position is not accurate enough…"): reject it, or set
  the pin on the customer page when someone is at the clinic.
- Also P1–P8.

---

## 6. Sales rep

### 6.1 What you see

**Home** (`/ar`), subtitle "Your plan, your visits and your month so far.", in this order:

| Card | What it shows | Opens |
|------|---------------|-------|
| Button **Start my day** (ابدأ يومي) | | My day |
| **To do now** (المطلوب الآن) | **Visits planned today** (زيارات مخططة اليوم), **New clinics near you, not visited yet** (عيادات جديدة قريبة منك لم تُزَر بعد), **Orders to finish and send (drafts)** (طلبات لم تُكمَل وتُرسَل (مسودات)), **Follow-ups and tasks due** (متابعات ومهام مستحقة), each with its count | My day, Leads near me, draft orders, Tasks |
| **Today's plan** (خطة اليوم) | Today's planned visits in order, with time or **In progress** (جارية). Empty: **Plan visits** (خطّط الزيارات) | My day / Visit plan |
| **My visits today** (زياراتي اليوم) | Today's check-ins, **Done** (تمت) or **Open** (مفتوحة). Empty: **Check in at a clinic** (تسجيل وصول لعيادة) | Visits |
| **My month** (شهري): **Visits**, **Orders**, **Booked sales**, **Collected** | Your month so far against your target. The link **Full dashboard** (لوحة المؤشرات كاملة) opens **My performance** (أدائي). | Visits, Orders, Orders, Payments |

New clinics near you are in **To do now** and on the bottom bar **Leads**; there is no separate
card for them.

**Menu:**
- Home: Home, **My requests** (طلباتي) (the requests you made and their decisions),
  **Notifications**.
- Sales & CRM: **Customers** (your own), **Opportunities**, **Catalogue**, **My commission**
  (عمولتي).
- Field: **My day**, **Visits**, **Tasks**, **Visit plan**, **Coverage**, **Customers map**,
  **Leads near me**.
- Orders: **Orders**, **New order**, **Offers**, **Returns**.
- Finance: **Invoices** (your customers'), **Payments** (yours), **Collect payment**.
- Inventory: **Stock** (sellable stock you can promise).
- Reports: **Dashboard** (**My performance** (أدائي)), **Reports**.
- Phone bottom bar **Field shortcuts**: **Today** (اليوم), **Map** (الخريطة), **Leads** (عيادات
  قريبة), **Visits** (الزيارات), **Orders** (الطلبات).

**You don't see:** other reps' customers, approvals to decide, tracking of others, aging and
collections, commission rates, setup and admin screens.

### 6.2 Your tasks

**Every working day:**

**REP-1 Start my day.** Bottom bar **Today** (or `/ar/today`, **My day**) › card **My working day**
(يوم عملي) › **Start my day** (ابدأ يومي). First time only: read the notice › **I have read and
understood this notice** › **Start my day** again; on the phone allow location **While using the
app**, **Precise** on. Expected: **On shift** (في يوم العمل), "Since HH:MM", and soon "Last point
recorded at HH:MM"; the top bar shows **Tracking on**.

**REP-2 Look at leads near you.** Bottom bar **Leads** (`/ar/leads`): nearest first. **Show**:
**To visit** (للزيارة), **Planned today** (مخطط اليوم), **Not interested** (غير مهتم), **Converted**
(تم تحويلها), **All**; **View**: **List** (قائمة) / **Map** (خريطة). On a lead: **Add to today's
plan** (أضف إلى خطة اليوم), **Directions** (الاتجاهات), **My notes** (ملاحظاتي) › **Save notes**
(your own notes only; never paste text from Google), **Mark visited** (تمت الزيارة) or **Not
interested** (غير مهتم).

**REP-3 First visit at a lead.** On the lead (`/ar/leads/<id>`), at the clinic: **First visit**
(أول زيارة) › **Doctor's name** (اسم الطبيب) and/or **Clinic name** (اسم العيادة), **Phone
(optional)** (الهاتف (اختياري)), **Specialty** (التخصص), **Governorate** (المحافظة), **City or
area** (المدينة أو المنطقة), **Notes** › **Save and check in** (حفظ وتسجيل الوصول) › **Check in at
…** (تسجيل الوصول عند …). First time on this device: **I understand, use my location** (فهمت،
استخدم موقعي). Expected: the clinic becomes your customer at stage **Prospect**; the check-in
says "This clinic has no verified location yet…", and your position is proposed as the clinic
pin for a manager to confirm.

**REP-4 Check in at a customer.**
- Planned: **Today** › **Today's plan** › **Check in at <name>**.
- Not planned: **Today** › **Unplanned visit** (زيارة غير مخططة) (`/ar/visits/new`) › search the
  customer › **Check in**.
- From the customer page: **Check in** (تسجيل وصول).

Stay where you are while "Getting your location…" shows. The **GPS result** (نتيجة GPS):
**Verified** (موثّقة) = you are at the clinic and the visit counts; **Out of range** (خارج النطاق)
= too far from the saved location; **Low GPS accuracy** (دقة GPS منخفضة); **No clinic location**
(لا يوجد موقع للعيادة); **No location** (بدون موقع).

**REP-5 Check in without location, and exceptions.** If location is refused or not available,
use **Check in without location** (تسجيل الوصول بدون موقع). Then, and for any result other than
Verified, open the visit › **Request an exception** (طلب استثناء) › **Why should this visit
count?** › **Request exception** (طلب استثناء). Expected: "Exception requested. A manager will
review it." Your manager sees the distance, the GPS accuracy and your reason.

**REP-6 Check out.** **Today** › **Visits in progress** (زيارات جارية) › **Check out** (تسجيل
المغادرة) › **Outcome** (النتيجة) (for example **Order taken**, **Interested**, **Needs
follow-up**, **Not interested**, **Doctor unavailable**, **Collection**) › **Notes (optional)** ›
**Next follow-up (optional)** › **Check out**. Expected: "Checked out." or "Checked out. A
follow-up task was created." (it appears under **Follow-ups** on Today).

**REP-7 Add a customer.** `/ar/customers` › **New customer** (عميل جديد): **Clinic name** and/or
**Doctor's name**, **Mobile or phone** (optional), **Governorate**, **City / district** ›
**Create customer** (إنشاء العميل). If "A similar customer already exists" appears, check it is not
the same clinic, then **Create anyway** (إنشاء على أي حال) or **Cancel**. A new customer starts as
a **Lead** (عميل محتمل); the territory comes from the governorate and city.

**REP-8 Add a missing phone.** `/ar/customers` › chip **Phone missing** (بدون هاتف) › a customer ›
**Add phone** (إضافة هاتف) › **Mobile or phone** `010…` › **Save phone** (حفظ الهاتف). Expected:
"Phone saved." The call and WhatsApp buttons replace **Add phone**. A saved phone cannot be
cleared.

**REP-9 Take an order.** **New order** (`/ar/orders/new`, or from the customer or the visit):
1. **Customer** › choose.
2. **Offers for this customer** (عروض هذا العميل) › **Add** (إضافة) for a package or offer (no
   approval needed).
3. **Search products** (ابحث في المنتجات) › **Add** › **Quantity**.
4. Per line, **Price** (السعر): **List price** (سعر القائمة), **Discount %** (نسبة خصم), **Net price**
   (سعر صافٍ) (net unit price before VAT) or **Free / bonus** (مجاني / هدية).
5. Optional **Discount on the whole order**: **None**, **Amount (EGP)** or **Percentage**.
6. **Update prices** (تحديث الأسعار): **Updated prices (not saved yet)** shows each line, VAT per
   product rate, the total, and whether approval will be needed and why.
7. **Save and review prices** (حفظ ومراجعة الأسعار) › **Submit order** (إرسال الطلب).

Expected: **Submitted** (مُرسل) when within your limits (your manager then accepts it), or
**Pending approval** (بانتظار الموافقة) with **Open the approval request**. You are notified when
it is decided.

**REP-10 Discounts and free items.** Your manual discount limit is 0 %: any **Discount %**, lower
**Net price** or whole-order discount needs approval ("The manual discount is above your
limit."). Up to 25 % your manager or the sales director decides; above 25 % "…will need the
owner's approval." A **Free / bonus** line outside an offer needs a sales manager ("A free item
outside an offer needs a sales manager."). Free lines are priced 0, carry no VAT and earn no
commission.

**REP-11 Change or cancel an order.** A draft: **Edit draft** (تعديل المسودة), or **Cancel order…**
(إلغاء الطلب…). After it is submitted it cannot be edited. An accepted order: **Request
cancellation…** (طلب الإلغاء…) › **Reason** › **Send cancellation request** (the sales director
decides).

**REP-12 Collect a payment.** **Collect payment** (`/ar/finance/payments/new`) or the customer
page › **Record payment** (تسجيل تحصيل): **Customer** › **Amount received (EGP)** › **Method**:
**Cash** (نقدًا), **Cheque** (شيك) (with **Cheque number** and **Cheque due date**), **Bank
transfer**, **InstaPay** … › **Reference (optional)** › **Received at (optional)** (at most a few
days back) › **Record payment** (تسجيل الدفعة). Expected: **Waiting for verification** (بانتظار
التحقق); finance confirms it. Needs a connection.

**REP-13 Request a return.** Order page › **Request return** (طلب مرتجع) (or **Returns** › **Request
a return**): **Quantity** per line and lot › **Reason** › **Notes** (no patient data) › **Send for
approval** (إرسال للموافقة). Expected: "Return requested. It now waits for approval." Only
delivered and invoiced goods can be returned. A pending return you requested can be withdrawn:
**Cancel this return** › **Reason** › **Cancel the return**.

**REP-14 End my day.** **Today** › **End my day** (أنهِ يومي) › **Yes, end my day** (نعم، أنهِ يومي).
If points are waiting, wait for "All points sent" first. Expected: "Your day has ended (H h MM
min)." **See my day** (اعرض يومي) shows your route, stops and visits.

**Other regular tasks:**

**REP-15 Tasks and follow-ups.** **Tasks** (`/ar/tasks`): **Mine**, **Open**, **Due today**,
**Overdue**; **Done** (تم) › **Outcome** › **Mark as done**. On a visit: **New task for this
customer**.

**REP-16 Notes on a customer.** Customer page › tab **Activity** (النشاط) › **Log an activity**
(تسجيل نشاط) › **Type** › **What happened** › **Add to timeline** (إضافة إلى السجل).

**REP-17 Opportunities.** **Opportunities** › **New opportunity** (فرصة جديدة) › customer › **What
is the opportunity?** › **Expected value (EGP)** › **Expected close date** › **Create opportunity**.
A follow-up task is added for 3 days later. Move it with **Move** › **Move to**.

**REP-18 Plan your week.** **Visit plan** (`/ar/planning`) › **Add a visit** › **Customer** ›
**Day** › **Add to plan**; or **Generate month plan** › **Propose** › **Save**. **Coverage** shows
which of your customers are overdue for a visit.

**REP-19 Commission statement (monthly).** **My commission** (`/ar/commissions`), **Commission
statement** (كشف العمولة): choose the **Month**; **From collected cash to commission** shows
**Collected cash (incl. VAT)** › **VAT excluded** › **Commissionable amount (excl. VAT)** ›
**Commission** › **Clawbacks** › **Approved adjustments** › **Net commission**; the lines below;
**Print statement** (طباعة الكشف). A month is **Provisional** (مبدئي) until it closes on day 6 of the
next month.

**REP-20 My performance and exports.** **Dashboard** (`/ar/dashboard`, **My performance**) and
**Reports** (your invoices, payments, visits and stock as CSV; a code when enforced).

### 6.3 Rules that affect you

- Manual discount 0 % without approval; offers always allowed (decision B).
- Prices, VAT and totals are worked out by Honest OS; offline prices are indicative only.
- A visit counts when it is **Verified** or its exception is approved.
- Payments wait for finance's verification; a payment can be back-dated a few days at most.
- Commission: earned on collected cash without VAT, at the rate of that day; free lines earn
  nothing; returns within 90 days of collection, bounced cheques and reversed allocations reduce
  the month they happen in; a closed month never changes.
- Your location is recorded only between Start my day and End my day.

### 6.4 Problems and what to do

| What you see | What to do |
|--------------|------------|
| "Location permission is blocked for this site." / "The phone's location is switched off" | Turn location on (phone quick settings) and allow it for Honest OS (§2.8), or **Check in without location** and request an exception (REP-5). |
| **Out of range** (خارج النطاق) | You were more than about 150 m from the saved location. If you were really at the clinic, request an exception and explain (for example "the clinic moved to the next street"). |
| **Low GPS accuracy** | Move near a window or outside and try again next time; request an exception now. |
| **No clinic location** | The clinic has no pin yet; your check-in proposes one. Request an exception so the visit counts. |
| "Submitting this order will need approval." | Normal for any manual discount or a free item outside an offer. Submit; the approver is notified. Use an owner offer to avoid approval. |
| "Updating prices needs a connection." / offline order | Save the draft on the device (**Save draft on this device**); submit when online (P3). |
| Leads show **Clinic (name not loaded)** or "Your base location is not set yet" | The owner's Google setup or your base address is missing (P6); ask the owner. |
| "No delivered orders to return from." | Returns start from a delivered and invoiced order. |
| Also P1–P9 | |

---

## 7. Finance officer

### 7.1 What you see

**Home** (`/ar`), subtitle "Money in today, what customers owe, and what waits for you.", cards in
this order:

| Card | What it shows | Opens |
|------|---------------|-------|
| **To do now** (المطلوب الآن) | **Payments waiting for verification** (مدفوعات بانتظار التحقق), **Orders ready to invoice** (طلبات جاهزة للفوترة), **Overdue invoices** (فواتير متأخرة السداد), **Received returns to credit** (مرتجعات مستلمة لإشعار دائن), **Requests waiting for your approval** (طلبات بانتظار موافقتك), each with its count | Payments to verify, Orders to invoice, overdue invoices, Returns to credit, Approvals |
| **Receipts today** (تحصيلات اليوم) | Total received today, number of payments, how many await verification (bounced and reversed ones not counted) | Payments |
| **Receivables aging** (أعمار المديونيات) | Total open, overdue, buckets **Not yet due**, **1–30 days**, **31–60 days**, **61–90 days**, **Over 90 days**, customers owing | Aging |
| **Waiting for your approval** (بانتظار موافقتك) | Credit notes, write-offs and credit-limit stages waiting for you | Approvals |

**Menu:**
- Home: Home, **Approvals**, **Notifications**.
- Sales & CRM: **Customers**, **Catalogue**, **Commissions** (العمولات), **Commission periods**.
- Field: **Customers map**.
- Orders: **Orders**, **Offers**, **Returns to credit** (مرتجعات لإشعار دائن).
- Finance: **Invoices**, **Payments**, **Collect payment**, **Aging**, **Collections**.
- Reports: **Dashboard** (لوحة المؤشرات) (company figures, owner decision 2026-11-28), **Reports**
  (invoices, payments, aging).
- Admin: **Delegations**, **Escalations**.

**You don't see:** field screens, stock screens, targets, setup and admin screens, commission
rates.

### 7.2 Your tasks

**Daily:**

**FIN-1 Verify payments.** `/ar/finance/payments` › filter **To verify** (للتحقق) › a payment ›
check amount, method and **Money received on** (a back-dated payment says so) › **Confirm
payment** (تأكيد الدفعة). Expected: "Payment confirmed and posted to the customer's account.",
status **Confirmed** (مؤكدة). If the money did not arrive: **Reject** (رفض) › **Reason** (tick
**The cheque bounced** (الشيك مرتد) for a cheque) › **Reject payment**. Cheques always wait until
they clear. Your own non-cheque payments are confirmed when you record them.

**FIN-2 Allocate payments to invoices.** On a confirmed payment, **Allocate to invoices** (التوزيع
على الفواتير): **Allocate oldest first** (توزيع على الأقدم أولًا), or **Choose amounts** (تحديد
المبالغ) › amount per invoice › **Allocate these amounts** (توزيع هذه المبالغ). Expected: the
invoices under **Allocations** (التوزيعات) and the invoice **Paid** or **Partially paid**. Filter
**Unallocated** (غير موزعة) shows what is left. A wrong allocation: **Undo** (تراجع) › reason ›
**Undo allocation** (code when enforced).

**FIN-3 Issue invoices.** `/ar/finance/invoices` › **Orders to invoice** (طلبات للفوترة)
(`/ar/finance/invoices/new`) › an order › check **What will be invoiced** (ما سيتم فوترته) › **Issue
invoice** (إصدار الفاتورة). Or on the order page › **Issue invoice** (إصدار فاتورة). Expected:
invoice `INV-…`, **VAT summary** per rate, **Print invoice** (طباعة الفاتورة) (A4, Arabic or English
via **Document language**). Partly delivered orders are invoiced for what was delivered. An issued
invoice cannot be edited.

**FIN-4 Collections.** `/ar/finance/collections` (**Collections**): one task per overdue invoice.
On a task › **What happened?** (ماذا حدث؟): **Promise to pay** (وعد بالسداد) with **Promised date**
and amount, **Escalate** (تصعيد), **Collected** (تم التحصيل) (once nothing is open), **Close**
(إغلاق) (escalate and close need a note) › **Save**. **Promise broken** (لم يُوفَ بالوعد) shows when
the date passed.

**FIN-5 Approvals.** `/ar/approvals` › **To decide**: credit notes, write-offs and the credit stage
of orders over the credit limit. You cannot decide a request you made.

**Weekly:**

**FIN-6 Aging and statements.** `/ar/finance/aging` (**Receivables aging**): tap an amount to see
its invoices; **Show every overdue invoice**; **Statement** (كشف الحساب) per customer
(`/ar/finance/customers/<id>/statement`) › **From** / **To** › **Show** › **Print**. A positive
balance is owed by the customer; a negative balance is the customer's credit.

**FIN-7 Credit notes.** Invoice page › **Request a credit note** (طلب إشعار دائن) › **Credit by**:
**Quantities** (الكميات) or **Amount** (مبلغ) (without VAT; VAT is added at the invoice's rate) ›
**Reason** › **Request credit note**. Expected: "Sent for approval. It takes effect once
approved." A second person approves it.

**FIN-8 Credit a received return.** **Returns to credit** (`/ar/returns?status=received`) › a return
› **Credit the customer** › **Issue the credit note** (إصدار الإشعار الدائن). Expected: **Credited**
(صدر إشعار دائن). It is computed from the invoice lines with VAT. If the invoice was already paid,
the excess stays as customer credit for later invoices; it is never paid out in cash. Code when
enforced.

**FIN-9 Write-offs.** Invoice page › **Request a write-off** (طلب شطب مبلغ) › **Amount to write
off, VAT included (EGP)** (at most the open amount) › **Reason** › **Request write-off**. A second
person approves it (**Decide write-offs**; code when enforced).

**FIN-10 Reverse a payment.** Payment page › **Reverse payment** (إلغاء الدفعة) › **Reason** ›
**Reverse payment**. Use it for money that never arrived after confirmation. It also claws back
commission. Code when enforced.

**Monthly:**

**FIN-11 Commission month.** `/ar/commissions/periods` (**Commission periods**): each month is
recalculated every night and closes automatically on day 6 of the next month. **Recalculate
<month>** (إعادة حساب …) for an up-to-date statement ("The month was recalculated."). To close
early: tick "I checked the {month} statements and want to close the month." › **Close <month>**.
A closed month is final; later events go to the next open month. Code when enforced.

**FIN-12 Exports.** `/ar/reports`: invoices, payments, receivables aging › **Download CSV**.

**FIN-13 Company dashboard.** **Dashboard** (`/ar/dashboard`), **Company overview** (نظرة عامة على
الشركة): the company's figures for the period you pick, grouped as **Field activity** (النشاط
الميداني), **Sales** (المبيعات), **Collections and receivables** (التحصيلات والذمم) and
**Operations** (العمليات), the team table, the territory and brand tables and **Overdue
customers** (العملاء المتأخرون). You read it; targets are set by the sales director and the owner.
The stock-alert tile is not shown to finance.

### 7.3 Rules that affect you

- Never delete money: corrections are credit notes, reversals, undo of allocations and
  write-offs, each with a reason and kept in the history.
- Credit notes and write-offs need a second person.
- A credit may not exceed the invoice's open amount.
- VAT is stored per invoice line; a later VAT change never alters an issued invoice.
- E-invoicing to the tax authority is not connected yet (**E-invoice (ETA)**: "Not submitted").

### 7.4 Problems and what to do

- **Confirm payment is missing:** the payment is not **Waiting for verification** any more, or
  you lack the right; check its status.
- **"The total is above your allocation limit."**: allocate in smaller parts or ask the owner.
- **Credit note pending for days:** another finance person or the owner must approve it; check
  **Escalations**.
- Also P1–P8.

---

## 8. Collection officer

The collection officer follows up overdue invoices and collects money, and visits clinics for it:
since the owner's decision of 2026-11-28 you work the field like a rep, for visits (working day,
check-in and check-out, your own visits), without orders, leads or commissions.

### 8.1 What you see

**Home** (`/ar`), the finance home ("Money in today, what customers owe, and what waits for you."),
in this order:

| Card | What it shows | Opens |
|------|---------------|-------|
| Button **Start my day** (ابدأ يومي) | | My day |
| **To do now** (المطلوب الآن) | **Visits planned today** (زيارات مخططة اليوم), **Overdue invoices** (فواتير متأخرة السداد), each with its count | My day, overdue invoices |
| **My visits today** (زياراتي اليوم) | Today's check-ins, **Done** (تمت) or **Open** (مفتوحة). Empty: **Check in at a clinic** (تسجيل وصول لعيادة) | Visits |
| **Receipts today** (تحصيلات اليوم) | Your payments received today | Payments |
| **Receivables aging** (أعمار المديونيات) | As §7.1 | Aging |

**Menu:**
- Home: Home, **My requests** (طلباتي), **Notifications**.
- Sales & CRM: **Customers**.
- Field: **My day** (يومي), **Visits** (الزيارات) (your own), **Tasks**, **Visit plan** (خطة
  الزيارات), **Coverage** (التغطية), **Customers map**.
- Finance: **Invoices**, **Payments** (yours), **Collect payment**, **Aging**, **Collections**.
- Reports: **Reports** (invoices, payments, aging, your visits).
- Phone bottom bar **Field shortcuts**: **Today** (اليوم), **Map** (الخريطة), **Visits** (الزيارات).

**You don't see:** approvals to decide, orders, leads, commission, the dashboard, stock, other
people's visits or tracking, admin screens.

### 8.2 Your tasks

**Every working day you go out:**

1. **Start my day** (ابدأ يومي): from the home button or the bottom bar **Today**, as REP-1 (the
   tracking notice the first time; on the phone allow location **While using the app**). Your
   location is recorded only until **End my day** (أنهِ يومي), as for reps (§1, privacy).
2. Plan the visits you will make: **Visit plan** (`/ar/planning`) › **Add a visit** (إضافة
   زيارة) › **Customer** › **Day** › **Add to plan**, as REP-18. **Coverage** shows customers
   overdue for a visit.
3. Check in at the clinic (planned: **Today** › **Today's plan**; not planned: **Unplanned
   visit** (زيارة غير مخططة) or the customer page › **Check in** (تسجيل وصول)), as REP-4. If the
   result is not **Verified**, open the visit › **Request an exception** (طلب استثناء), as REP-5.
4. Collect the payment at the visit: **Collect payment** as REP-12. Expected: **Waiting for
   verification** until finance confirms.
5. **Check out** (تسجيل المغادرة) with the **Outcome** **Collection** (or another outcome), as REP-6.
6. **End my day** (أنهِ يومي) › **Yes, end my day**, as REP-14.

**At the office:**

1. **Collections** (`/ar/finance/collections`): work each task as FIN-4 (promise, escalate,
   collected, close).
2. **Aging** and **Statement**: as FIN-6, to know what each customer owes before you call or
   visit.
3. **Write-off request** for an amount the customer will not pay: as FIN-9; finance decides.
4. **Visits** (`/ar/visits`): your own visits and their GPS result.

### 8.3 Rules, problems

As §7.3, plus the rep's visit rules (§6.3): a visit counts when it is **Verified** or its exception
is approved; your location is recorded only during your working day. Your visit exceptions go to
the sales director (or the owner). The owner and the sales director see your working day; finance
does not. Problems: as the rep's (§6.4) for check-in and location; P1–P9.

---

## 9. Inventory manager

### 9.1 What you see

**Home** (`/ar`), subtitle "Orders to reserve and deliver, returns to receive and stock to watch.":

| Card | What it shows | Opens |
|------|---------------|-------|
| **To do now** (المطلوب الآن) | **Approved orders to reserve stock for** (طلبات معتمدة تحتاج حجز المخزون), **Reserved orders to deliver** (طلبات محجوزة جاهزة للصرف), **Approved returns to receive** (مرتجعات معتمدة للاستلام), **Goods receipts to post** (أذونات استلام لم تُرحَّل), **Items at or below their reorder point** (أصناف عند حد إعادة الطلب أو أقل), each with its count | the filtered list of each |
| **Your screens** (شاشاتك) | Your menu as shortcuts, by department | each screen |

**Menu:**
- Home: Home, **My requests** (طلباتي) (your own requests), **Notifications**.
- Sales & CRM: **Catalogue**.
- Orders: **Orders**, **Offers**, **Returns to receive** (مرتجعات للاستلام).
- Inventory: **Stock**, **Stock ledger**, **Goods receipts**, **Transfers**, **Adjust stock**.
- Reports: **Reports** (stock).
- Admin: **Delegations**, **Escalations**.

**You don't see:** customers, finance, field and admin screens.

### 9.2 Your tasks

**Daily:**

**INV-1 Reserve and fulfil orders.** `/ar/orders` › filter **Approved** (المعتمدة) › an order ›
**Warehouse** (المستودع) › **Reserve stock** (حجز المخزون) › **Post fulfilment** (تسجيل التنفيذ).
Expected: **Reserved** (محجوز), then **Fulfilled** (منفذ) or **Partially fulfilled**. Stock is taken
earliest expiry first. Finance invoices next.

**INV-2 Goods receipts.** `/ar/inventory/receipts` › **New receipt** (استلام جديد) › **Receiving
warehouse**, **Supplier**, **Shipment reference** › lines: **Product / SKU**, **Lot number** (`NO-LOT`
for products without lots), **Expiry date**, **Quantity**, **Purchase cost per unit (EGP)** › **Save
draft receipt** (حفظ مسودة الاستلام). Check it › **Post receipt** (ترحيل الاستلام) › **Confirm: post
to stock**. Expected: "Receipt posted. Stock updated." Expired lots go only into a quarantine
warehouse.

**INV-3 Returns into quarantine.** **Returns to receive** (`/ar/returns?status=approved`) › a return
› count the goods › **Quarantine warehouse** (مخزن الحجر) › **Receive the goods** (استلام البضاعة).
Expected: **Received** (تم الاستلام); the units sit in quarantine and are not sellable.

**INV-4 Stock and alerts.** `/ar/inventory` (**Stock**): **Show** **Below reorder point** (تحت حد
إعادة الطلب), **Expiring within 90 days**, **Expired**, **Not sellable**. A product page shows
stock by warehouse and lot with expiry, the **Unit cost** of each lot (or **Cost unknown**, which
only the owner sets), **Adjust**, **Transfer** and **View this SKU in the stock ledger**.

**Weekly / as needed:**

**INV-5 Transfers.** `/ar/inventory/transfers` › **New transfer** (تحويل جديد) › **From warehouse**
› **Continue** › **To warehouse** › **SKU and lot** › **Quantity** › **Save draft transfer** ›
**Ship** (شحن) › **Confirm: ship now** (stock is **In transit**, not sellable) › at the destination
**Receive** (استلام) › **Confirm: received in full**.

**INV-6 Release from quarantine.** A transfer from the quarantine warehouse to a sellable one
releases the goods ("This releases quarantined stock: once received at … it can be sold."). Only
release stock that passed its quality check. Code when enforced.

**INV-7 Adjustments.** **Adjust stock** (`/ar/inventory/adjustments/new`) › warehouse ›
**Continue** › **SKU and lot** › **Change**: **Remove units** (خصم وحدات) or **Add units** (إضافة
وحدات) › **Units** › **Reason** (**Count correction**, **Found stock**, **Damaged**, **Lost**,
**Expired**, **Sample or demo**, **Other**) › **Note** › **Submit adjustment** (إرسال التسوية). Up
to 5 units per product and warehouse per day post at once; above that "Over your daily limit:
sent for approval." and the owner decides. **Stock adjustments** (`/ar/inventory/adjustments`)
lists them.

**INV-8 Catalogue.** `/ar/catalog` › **New product** (منتج جديد) › **Create product**, then its
variants (SKUs) › **Save variant**. Prices are the owner's.

**INV-9 Stock ledger.** `/ar/inventory/movements`: every movement, newest first; read-only.

**Monthly:** a stock count with adjustments (**Count correction**); export stock from **Reports**.

### 9.3 Rules that affect you

- The stock ledger is append-only: mistakes are corrected with a new movement, never by editing.
- A posted receipt cannot be edited; corrections are adjustments.
- Negative stock is blocked; quarantine, transit and expired stock are never sellable.
- Adjustments above the daily limit wait for approval.

### 9.4 Problems and what to do

- **"No sellable stock is visible for these products in any warehouse."**: receive the goods or
  transfer them to a sellable warehouse first.
- **"There is no active quarantine warehouse."**: ask the owner to create it on **Setup**.
- **"Receiving this transfer releases quarantined stock and needs the quarantine release
  permission."**: only you (or the owner) can receive it.
- **My requests lists only requests you made:** correct; your role raises requests (stock
  adjustments above the daily limit), the owner decides them.
- Also P1–P8.

---

## 10. Admin

The admin manages people's access and the system's rules, without any money or stock authority.

### 10.1 What you see

**Home** (`/ar`), subtitle "Your screens, one tap away.": **Your screens** (شاشاتك), your menu as
shortcuts by department. Permission codes are shown on the user and role screens, not on the home.

**Menu:** Home, **My requests** (طلباتي), **Notifications**; **Catalogue**; Admin: **Users**, **Employees**, **Territories**,
**Roles & permissions**, **Settings**, **Security events**, **Approval rules**.

**You don't see:** **Setup**, **Data import** and **Audit log** (owner only); money, stock, field
and approval screens.

### 10.2 Your tasks

**ADM-1 Users.** `/ar/admin/users` (**Users**): status tabs, search. **Invite user** (دعوة مستخدم) ›
**Create and send invitation** sends an e-mail invitation: it does not arrive until company e-mail
is set up; until then the owner creates logins with a one-time link on **Setup**. A person ›
**Manage roles**: **Grant a role** (منح دور) › role › **Territory (optional)** › **Grant role** (منح
الدور); **Revoke** (سحب) › **Confirm revocation**. **Suspend** (إيقاف) › reason › **Confirm
suspension** stops all access at once; **Reactivate** (إعادة تفعيل).

**ADM-2 Employees.** `/ar/admin/employees` › **New employee** (موظف جديد), or a person: manager,
department, territories, status. A job title grants nothing; roles do.

**ADM-3 Territories.** `/ar/admin/territories`: territories and their coverage (governorate,
city), which decides where new customers belong.

**ADM-4 Roles.** `/ar/admin/roles` › a role: permissions grouped by module, each with **Scope**
(النطاق) (Own, Team, Territory, All) and **Limit** › **Grant** / **Save** / **Remove**; **New role** ›
**Create role**. You can only grant what you hold yourself, and you cannot change a role you hold.
Permissions marked **Sensitive** (حساسة) raise a critical security event.

**ADM-5 Settings.** `/ar/admin/settings`: **Change** › **New value** › **Reason** › **Save**. Settings
marked **Owner only** have no edit form for you.

**ADM-6 Approval rules.** `/ar/workflow/rules` (**Approval rules**) › a workflow › **New rule** /
**Edit rule**: **Priority** (lower numbers are checked first), **When** (condition), **Stages, in
order** › **Add stage**: **Who approves** (a permission holder, a role, the requester's manager or
a named person), **Approvals needed**, **Escalate after (hours)** › **Save stage**. Every workflow
keeps a catch-all rule. Rules that approve automatically are owner only.

**ADM-7 Security events.** `/ar/admin/security`: filter by severity (**Info**, **Warning**,
**Critical**). Check it weekly with the owner.

**Onboarding a person:** ADM-2 (employee) › login (the owner's **Setup** link until e-mail works) ›
ADM-1 (role and territory). **Offboarding:** ADM-1 **Suspend** (immediate), then end the
employee's territories.

### 10.3 Rules that affect you

- No money, stock or approval authority; no audit log, setup or imports.
- Grant ceiling: you cannot give access you do not hold, nor change your own access ("You can't
  change your own access.").
- The last owner cannot be suspended or lose the owner role.
- Changing roles, settings or rules needs a code when enforced.

### 10.4 Problems and what to do

- **"You can't grant access you don't hold yourself."**: ask the owner to grant it.
- **"At least one active owner must remain."**: you tried to remove or suspend the last owner.
- **A new user can do nothing** ("This user has no active roles…"): grant a role.
- Also P1–P8.

---

## 11. Glossary

Arabic terms as the screens show them. Where two screens use different Arabic words for the
same thing, both are given.

| English | Arabic | Meaning |
|---------|--------|---------|
| Leads near me, a lead | عيادات قريبة، عيادة قريبة | A clinic Google finds around the rep's base, not a customer yet |
| Lead (customer stage) | عميل محتمل | First stage of a customer record |
| Prospect | مهتم | A customer after the first visit (customers, leads, map legend, reports) |
| Active / Dormant / Lost / Blocked | نشط / خامل / مفقود / موقوف | Customer stages |
| Visit, check-in, check-out | زيارة، تسجيل الوصول، تسجيل المغادرة | |
| Verified | موثّقة | The visit was at the clinic |
| Visit exception | استثناء زيارة | Manager's approval for a visit that could not be verified |
| Pin proposal | موقع مقترح | A check-in position proposed as the clinic's location |
| Start my day / End my day | ابدأ يومي / أنهِ يومي | Opens and closes the working day (tracking) |
| Offers and packages | العروض والباقات | Owner-defined deals; no approval |
| Promotion (automatic discount) | الخصومات التلقائية | Automatic percentage discount in the catalogue |
| List price / Net price | سعر القائمة / سعر صافٍ | |
| Free / bonus | مجاني / هدية | A line priced 0 |
| Discount on the whole order | خصم على الطلب كله | Counts as a manual discount |
| Submitted / Pending approval / Approved | مُرسل / بانتظار الموافقة / معتمد | Order statuses |
| Reserved / Fulfilled / Invoiced | محجوز / منفذ / مفوتر | Order statuses |
| VAT | ضريبة القيمة المضافة | Added per product rate, 14 % by default |
| Invoice, credit note | فاتورة، إشعار دائن | |
| Write-off | شطب (the request and the action) · معدومة (a written-off invoice) | Amount the customer will not pay |
| Payment, allocation | دفعة، توزيع | |
| Waiting for verification / Confirmed | بانتظار التحقق / مؤكدة | Payment statuses |
| Reverse payment | إلغاء الدفعة | |
| Receivables aging | أعمار الديون / أعمار المديونيات | Open invoices by days late |
| Statement | كشف الحساب | |
| Lot | تشغيلة | A batch of one product, with expiry (stock and returns) |
| Warehouse | المستودع / المخزن | |
| Quarantine | الحجر | Warehouse for returned goods; never sellable |
| In transit | في العبور | Shipped, not yet received |
| Adjustment | تسوية | A stock correction movement |
| Commission statement, clawback | كشف العمولة، استرداد | |
| Approval, delegation, escalation | موافقة، تفويض، تصعيد | |
| Authenticator app, code | تطبيق المصادقة، رمز | Two-step verification |
| Access denied | غير مسموح بالدخول | |
| To do now | المطلوب الآن | The list of open work at the top of your home |
| My requests | طلباتي | The requests you made (menu entry for people who do not decide approvals) |
| Pending sync | في انتظار المزامنة | Work saved on the device, not sent yet |

## 12. Who to contact

1. **Your direct manager** for daily questions about customers, visits, orders and discounts
   (area manager, then sales director).
2. **Finance** for invoices, payments, statements and credit notes; **inventory** for stock and
   deliveries.
3. **The admin** for logins, roles, a suspended account, "Access denied" and settings.
4. **The owner** for anything marked owner only (setup, maps and Google, offers, VAT, commission
   rates, discounts above 25 %, audit), for an approval nobody else can decide, and when the
   admin cannot help.
5. When something looks wrong, write down the page address, the time and any **reference** the
   message shows, and send it to the admin. Never send passwords, codes or sign-in links in a
   group chat.

---

## Appendix A: Technical setup (owner and admin)

This appendix uses technical words on purpose; reps and managers do not need it.

- Owner go-live steps, in order: [`docs/runbooks/owner-go-live.md`](runbooks/owner-go-live.md)
  (secrets, Google Maps keys and budget, Supabase settings and SMTP, MFA, setup, import, APK,
  sign-off).
- Google Maps: the browser key `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (maps) and the server key
  `GOOGLE_MAPS_SERVER_KEY` (clinic names, lead search, address search). Without them the map and
  lead screens show their "not available yet" states (P5, P6).
- E-mail (SMTP): needed for invitation e-mails, sign-in links and codes; until then use the
  one-time links on `/ar/admin/setup`.
- The authenticator-code switch is the owner-only setting `security.mfa_enforced` (Settings ›
  Security). Enrol owners first, then admin, finance, sales director and inventory manager.
- Android app: [`mobile/README.md`](../mobile/README.md); one-phone test day:
  [`docs/TESTING.md`](TESTING.md) §6.1.
- Sign-off click-through per role: [`docs/VERIFICATION.md`](VERIFICATION.md).
- Roles and permissions in detail: [`docs/AUTHORIZATION.md`](AUTHORIZATION.md); figures and their
  formulas: [`docs/DASHBOARDS.md`](DASHBOARDS.md).

## Appendix B: Known limits

Found while writing this manual; to confirm on staging.

- Reps can open `/ar/finance/collections` for collection tasks assigned to them, but it is not in
  their menu.
- Commission adjustments need a second owner (owner decision 2026-11-28): with one owner account,
  an adjustment the owner requested stays waiting.
- A collection officer's visit exceptions are decided by the sales director or the owner (the
  collection officer is usually not in an area manager's team).

Closed on 2026-11-27/28 (no longer limits): the **Collected**, **Open AR** and **Overdue** tiles now
open a list you can open (payments, open or overdue invoices) instead of **Access denied**; reps
and other roles that do not decide approvals have **My requests** in the menu; the inventory and
admin homes show **Your screens** instead of permission codes; the collection officer has **Start
my day** and a visits list; the finance officer opens the company dashboard; the sales director's
tracking covers the whole company; offers (العروض والباقات) and catalogue promotions (الخصومات
التلقائية) have different Arabic words.
