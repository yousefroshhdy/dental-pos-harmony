# Owner go-live steps (staging)

The steps that only the owner can do, in order. Steps 1–3 can be done by the script
`scripts/owner/go_live_setup.py` on the owner's own computer; steps 4–8 need the owner in person.
Never paste a key, token or password into a chat, a document or an e-mail.

## Run the script (steps 1–3)

1. Install Python 3.9+ (Windows: from python.org, tick "Add python.exe to PATH").
2. Copy `scripts/owner/go_live_setup.py` into a folder on your computer, e.g. `C:\Users\user\HonestOS`.
3. Create two tokens in your browser (keep the tabs open; you paste them into the script's hidden prompt):
   - Vercel: https://vercel.com/account/tokens → **Create** → scope: the team that owns `honest-os-staging`.
   - Supabase: https://supabase.com/dashboard/account/tokens → **Generate new token**.
4. For step 2 only: install the Google Cloud CLI (https://cloud.google.com/sdk/docs/install), run
   `gcloud auth login`, create a project in console.cloud.google.com and link a billing account to it.
5. In PowerShell, in that folder:
   ```
   py go_live_setup.py            # look only: shows what is set now
   py go_live_setup.py --apply    # make changes; asks "yes" before each one
   ```
6. Afterwards, delete both tokens (Vercel and Supabase token pages) if you do not need them again.

What each script step does:

| Step | What it changes | You do first |
|------|-----------------|--------------|
| 1 New secrets | Replaces `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `OUTBOX_SIGNING_SECRET` in Vercel as **Sensitive** (Production + Preview), the two random ones generated on your computer; redeploys and waits for READY | Supabase → Project Settings → **API Keys** → Secret keys → **Create new secret key**; copy it. Delete the **old** key only after the site works |
| 2 Google | Enables Maps JavaScript, Places (New), Geocoding; creates a browser key (only `https://honest-os-staging.vercel.app/*`, Maps JavaScript) and a server key (Places + Geocoding); sets `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` and `GOOGLE_MAPS_SERVER_KEY` (Sensitive); adds a monthly budget alert at 50/90/100 %; redeploys | gcloud signed in, project with billing |
| 3 Supabase | Exposed schemas `api,service`; leaked-password protection (may need a paid plan); optional SMTP (host, port, user, password, sender `no-reply@honesteg.co`) | SMTP details from your mail provider |
| 4 Show | Read-only: variable names and types, Supabase settings, site answers | — |

## By hand (steps 4–8)

4. **MFA:** sign in at `/ar` → `/ar/account/security` → **إعداد تطبيق المصادقة** (Set up authenticator app) → scan → enter the code.
5. **Setup** on `/ar/admin/setup`: **إنشاء المخزن الرئيسي** (main warehouse, code `WH-MAIN`); **تغطية الدقهلية بمنطقة المنصورة**; **إنشاء مخزن الحجر** (code `WH-QRN`); per person **إضافة شخص** → **إنشاء حساب دخول ودور** → **إنشاء الحساب والرابط** (send the link privately); per rep **عنوان الانطلاق** → **البحث على الخريطة والحفظ**, radius 5 km.
6. **Import** on `/ar/admin/setup/legacy-import`: upload → **رفع ومراجعة** → decide each negative item → **بدء الاستيراد** → per step **تجربة** then commit, in order. Then each "cost unknown" item → **تحديد التكلفة** per lot. Then `/ar/commissions/plans` → STD-2026 → **تفعيل هذه الخطة**.
7. **APK:** `mobile/README.md` → "Install the pilot app, step by step"; then the one-phone test day (`docs/TESTING.md` §6.1).
8. **Sign-off:** `docs/VERIFICATION.md` §0 (S-01 to S-11) with test records only; fill in the record table; only you set Verified.
