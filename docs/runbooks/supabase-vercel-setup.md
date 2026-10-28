# Runbook — Supabase & Vercel setup for Honest OS

> Who: the **owner** (or someone acting with the owner present). Accounts must be **company-owned** (D-08), with MFA.
> Status: written 2026-10-28; not yet executed. Follow the steps in order and tick them off.

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
   - **Authentication → Multi-Factor:** enable TOTP.
   - **Authentication → URL Configuration:** Site URL `https://app.honesteg.co` (staging: its Vercel URL). Add redirect URLs `https://app.honesteg.co/ar/auth/confirm` and `https://app.honesteg.co/en/auth/confirm`.
   - **Authentication → Email templates.** The Magic Link and Invite templates must use the token-hash link that `src/app/[locale]/auth/confirm/route.ts` expects:
     ```
     {{ .SiteURL }}/ar/auth/confirm?token_hash={{ .TokenHash }}&type=email
     ```
     Use `type=invite` in the Invite template. Write the template body in Arabic and English.
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
6. **Cron Jobs:** `vercel.json` schedules `/api/cron/outbox`. Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when `CRON_SECRET` is set.

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
