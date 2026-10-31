# Runbook — Supabase & Vercel setup for Honest OS

> Who: the **owner** (or someone acting with the owner present). Accounts must be **company-owned** (D-08), with MFA.
> Status: written 2026-10-28; not yet executed. Follow the steps in order and tick them off.

## Staging as built (2026-10-30)

| Item | Value |
|------|-------|
| Supabase project | `honest-os-staging`, ref `hhdctubhbdqriyqwjgfk`, eu-central-1, Free plan |
| Database | All 66 migrations applied (2026-10-31, each fetched from GitHub at a pinned commit with an md5 check). All 52 suites, 2687 pgTAP assertions, pass there in a rolled-back transaction; nothing persisted. Advisors: no security findings beyond the documented ones; performance shows only expected unused indexes on an empty database, 4 duplicate indexes (dropping them needs owner approval, rule 9) and 4 intentional multi-policy tables |
| Vercel project | `honest-os-staging` (Hobby), linked to `yousefroshhdy/dental-pos-harmony`, region fra1, Node 22 |
| URL | https://honest-os-staging.vercel.app (open; the app's own login applies). Preview deployments stay behind Vercel Authentication |
| Deployed branch | `ccr-cd8ec6c2-y28xig` (Vercel serves it as production for this project) |
| Env vars set | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable key), `NEXT_PUBLIC_APP_URL` |
| Cron | six daily jobs in `vercel.json` (outbox, overdue, kpi-snapshot, tracking, commissions, escalations; Hobby limit; see ARCHITECTURE §2.6) |
| Separation | Nothing is shared with the Noah projects (`noah-os`, `noor`) |

**Still to do (owner; secrets never go through chat):**
1. **Vercel → honest-os-staging → Settings → Environment Variables.** Add these three as **Sensitive**, for Production:
   - `SUPABASE_SERVICE_ROLE_KEY`, from Supabase → Project Settings → API Keys (secret key)
   - `CRON_SECRET`, generated with `openssl rand -hex 32`
   - `OUTBOX_SIGNING_SECRET`, generated with `openssl rand -hex 32`

   Then **Redeploy**.
2. **Supabase → honest-os-staging:**
   - **API → Exposed schemas:** set `api, service` and remove `public`.
   - **Authentication:** turn sign-ups off.
   - **URL Configuration:** set the Site URL to `https://honest-os-staging.vercel.app`, and add the redirects `https://honest-os-staging.vercel.app/ar/auth/confirm` and `https://honest-os-staging.vercel.app/en/auth/confirm`.
   - **Email template:** as in §2 below.
3. **Owner login:** Supabase → Authentication → Users → **Add user** (your email). Then, in the SQL editor: `select core.bootstrap_owner('<your email>', '<Your Name>');`
4. **Optional cleanup:** in the SQL editor run `drop extension if exists http;`. The `http` extension was used only to load migrations.
5. **Vercel → honest-os-staging → Settings → Environments → Production → Branch Tracking:** set the branch to `ccr-cd8ec6c2-y28xig`, so each push goes live. Until then pushes create previews, and production stays on the last manual deploy (commit `a80cf8c`).
6. **Wave 2 (2026-10-30):** in Supabase → Authentication, set the email OTP length (8) and expiry (600), add `{{ .Token }}` to the Magic Link template, set token verifications to 30 and enable TOTP (all in §2 step 3). Then follow the MFA rollout in §2a. The Android pilot APK steps are in §2b.

## 0. Before you start
- [ ] D-03: until the PDPL legal review clears it, load **synthetic data only** into any project, including production.
- [ ] Company email accounts exist for the two owners (e.g. `owner1@honesteg.co`, `owner2@honesteg.co`).
- [ ] A password manager is available for the secrets below.

## 1. GitHub
1. Create a GitHub **organization** for Honest® (Settings → Organizations → New organization). Enable "Require two-factor authentication".
2. Transfer or rename this repository to `honest-os` under that organization (Repository → Settings → General → Danger zone → Transfer). GitHub keeps redirects from the old name.
3. Branch protection on `main`: require a pull request, require status checks (`quality`, `database`, `build`, `e2e` from `.github/workflows/ci.yml`), block force pushes.

## 2. Supabase: two projects
1. supabase.com → sign in with the company owner account → **New organization** "Honest" (plan: Pro for production).
2. Create two projects: `honest-os-staging` and `honest-os-prod`.
   - **Region:** Central EU (Frankfurt) `eu-central-1` (ADR-020 / D-03).
   - Database password: generate a 32+ character password and store it in the password manager.
3. For each project, in **Project Settings**:
   - **API → Exposed schemas:** set to `api, service` and remove `public`. **Extra search path:** `extensions`. (`supabase/config.toml` mirrors this for local CLI use.)
   - **Authentication → Sign In / Providers:** Email enabled; **"Allow new users to sign up" OFF** (users are invited by an admin). Enable "Secure email change" and leaked-password protection.
   - **Authentication → Multi-Factor** (Sign In / Providers → Multi-Factor in newer UIs): set **TOTP (App Authenticator)** to Enabled (enrol and verify). Leave Phone and WebAuthn off. The default of 10 factors per user is fine. Without this, enrolment fails with `TOTP_DISABLED`. Nothing changes in the database for this step. Rollout of enforcement: §2a below.
   - **Authentication → Providers → Email → Email OTP:** set **Email OTP Length = 8** and **Email OTP Expiration = 600** seconds (10 minutes). The default (6 digits for 1 hour) is guessable within the rate limit. `supabase/config.toml` `[auth.email] otp_length` / `otp_expiry` mirror this. Leave the minimum interval between emails at 60 s.
   - **Authentication → Rate Limits:** set **token verifications** (OTP and magic-link verifications per 5 minutes per IP) to **30**; do not raise it, and do not lower it either: the app verifies codes from Vercel's egress IPs, so all users share that budget. Keep sign-ins/sign-ups at the default (30 per 5 minutes). Check that the MFA verification limits are acceptable. Re-check these values after any Supabase plan change.
   - **Authentication → URL Configuration:** Site URL `https://app.honesteg.co` (staging: its Vercel URL). Add redirect URLs `https://app.honesteg.co/ar/auth/confirm` and `https://app.honesteg.co/en/auth/confirm`.
   - **Authentication → Email templates.** The Magic Link and Invite templates must use the token-hash link that `src/app/[locale]/auth/confirm/route.ts` expects:
     ```
     {{ .SiteURL }}/ar/auth/confirm?token_hash={{ .TokenHash }}&type=email
     ```
     Use `type=invite` in the Invite template. Write the template body in Arabic and English.

     The **Magic Link** template must also contain the sign-in code **`{{ .Token }}`**, for the Android app ("Email me a sign-in code"). Without it the code email carries no usable code. Keep the link as well. For example:
     ```html
     <p>رمز الدخول: <strong>{{ .Token }}</strong> (صالح لمدة 10 دقائق)</p>
     <p>Your sign-in code: <strong>{{ .Token }}</strong> (valid for 10 minutes)</p>
     <p><a href="{{ .SiteURL }}/ar/auth/confirm?token_hash={{ .TokenHash }}&type=email">ادخل / Sign in</a></p>
     ```
   - **Authentication → SMTP:** configure the company SMTP or Workspace relay so emails come from `no-reply@honesteg.co`. The built-in sender is rate-limited and not for production.
   - **Database → Network restrictions / SSL:** enforce SSL.
   - **Database → Backups:** confirm daily backups. Enable **Point-in-Time Recovery** on prod before any financial data goes live (Phase 4 gate).
4. Apply the schema:
   ```bash
   npx supabase login                      # company owner account
   npx supabase link --project-ref <staging-ref>
   npx supabase db push                    # applies supabase/migrations/* in order
   npx supabase test db                    # runs supabase/tests/database/* with real pgTAP
   ```
   Repeat for prod **only after staging passes** and after the pull request is merged.
   `seed.sql` is for local/CI only. `db push` does not run it against hosted projects. Never run it against production.

## 2a. MFA step-up rollout (`security.mfa_enforced`, AUTHORIZATION §6.7)

The switch ships **off**; behaviour is unchanged until the owner turns it on.
1. Enable TOTP (§2 step 3). The Supabase **organisation** owner account (D-08) turns on its own MFA under Account → Security; that is separate from app MFA.
2. **Owners enrol first**, on `/ar/account/security`. Then, about two weeks ahead: admin, finance officer, sales director, inventory manager and catalogue manager (anyone holding a gated permission sees "Set up an authenticator app now"). **Since 2026-10-31 every CSV export permission is gated too**, so sales reps, area managers, collection officers and quality managers who export lists also need a TOTP factor before enforcement; otherwise they can still use every screen but cannot download CSVs. Check enrolment in Supabase → Authentication → Users. Each owner keeps a second factor or the break-glass procedure (§6).
3. **Staging first:** turn it on and run the MFA e2e checks (`docs/TESTING.md` §6).
4. **Production:** an owner turns it on from **Admin → Settings** during business hours. **Turning it on at aal1 is allowed.** It takes effect on the next request. Watch for `MFA_REQUIRED` in the `command.failed` logs.
5. **Every later change** to any `security.*` setting, including switching it off (rollback), **needs an aal2 session** (verify on `/account/security` first). An aal1 session gets `MFA_REQUIRED`.

## 2b. Android pilot APK

Build, signing and install steps are in [`mobile/README.md`](../../mobile/README.md). In short:
- Install only the **`honest-os-android-pilot`** artifact (`app-release.apk`, non-debuggable) from the GitHub Actions "Android" run; never `honest-os-android-debug`.
- Each CI run signs with a new SDK debug key, so uninstall the previous APK first (after the rep taps "End my day").
- Turn USB debugging off after installing. Production needs a real keystore in GitHub secrets.
- Set the repository variable `CAP_SERVER_URL` if the app should load anything other than the staging URL. Vercel Authentication protects preview deployments only (owner decision 2026-10-31), so the app works for reps without a Vercel account.
- D-03: synthetic data only until the legal review clears real use.

## 3. Bootstrap the first owner (once per project)
1. Dashboard → **Authentication → Users → Add user → Create new user**: owner email and a strong password, with "Auto confirm" on.
2. Dashboard → **SQL Editor** (runs with database-owner privileges) → run:
   ```sql
   select core.bootstrap_owner('owner1@honesteg.co', 'Owner Full Name');
   ```
   This refuses to run if an active owner already exists (`BOOTSTRAP_DONE`).
3. Sign in at `/ar/login`, enrol MFA, then use **Users → Invite** to add the second owner. Grant the second owner the Owner role (D-08).
4. Verify: **Security events** shows `owner_bootstrap` and `role_granted` entries.

## 4. Vercel
1. vercel.com → create a **Team** (Pro) owned by the company account; import the GitHub repository.
2. Framework preset: Next.js. Root directory: repository root. Install command: `pnpm install --frozen-lockfile`.
3. **Settings → Functions → Region:** Frankfurt (`fra1`), next to the database.
4. **Environment variables** (Production uses the prod Supabase project; Preview uses staging):

   | Name | Value | Exposure |
   |------|-------|----------|
   | `NEXT_PUBLIC_SUPABASE_URL` | Project URL | public |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / publishable key | public (protected by RLS) |
   | `NEXT_PUBLIC_APP_URL` | `https://app.honesteg.co` | public |
   | `SUPABASE_SERVICE_ROLE_KEY` | service role / secret key | **server only, Sensitive** |
   | `CRON_SECRET` | `openssl rand -hex 32` | **server only, Sensitive** |
   | `OUTBOX_SIGNING_SECRET` | `openssl rand -hex 32` | **server only, Sensitive** |

5. **Domains:** add `app.honesteg.co`, then create the CNAME record at the DNS provider for `honesteg.co`. The public site on Framer is not affected.
6. **Cron Jobs:** `vercel.json` schedules the six `/api/cron/*` routes (ARCHITECTURE §2.6); on Pro, move outbox and escalations to their frequent schedules. Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when `CRON_SECRET` is set.

## 5. Smoke test after each deploy
- [ ] `https://app.honesteg.co/api/health` returns `{"status":"ok"}`
- [ ] `/` redirects to `/ar/login`. The Arabic page renders right-to-left; the English switch works.
- [ ] Owner can sign in and sees **Users**, **Roles**, **Security events**.
- [ ] A test rep account (synthetic) sees only its own customers.
- [ ] Integrations health page: outbox has no dead letters.

## 6. Break-glass (owner locked out)
1. A second owner exists → they restore access via **Users**.
2. No owner can sign in → the Supabase **organization owner** opens SQL Editor and runs, with a witness present:
   ```sql
   update core.user_profiles set status = 'active' where user_id = (select id from auth.users where email = 'owner1@honesteg.co');
   insert into audit.security_events (event_type, severity, details)
   values ('break_glass', 'critical', jsonb_build_object('by', 'supabase-org-owner', 'reason', '<why>'));
   ```
3. Reset the password or MFA from Dashboard → Authentication → Users. Record the incident.
