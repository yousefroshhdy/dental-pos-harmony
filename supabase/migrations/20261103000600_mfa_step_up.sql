-- Honest OS migration: MFA (TOTP) step-up for sensitive permissions (docs/AUTHORIZATION.md §6.7).
--
-- A permission flagged `requires_mfa` can only be exercised from a session whose JWT carries
-- `aal: 'aal2'` (the user verified a second factor in this session), once the owner switches
-- `security.mfa_enforced` on. The switch ships OFF, so nothing changes until rollout.
--
-- Changes (all additive):
--   1. authz.permissions.requires_mfa (default false) + the sensitive set flagged
--   2. setting security.mfa_enforced = false
--   3. internal helpers authz.session_aal(), authz.mfa_enforced(), authz.require_mfa(perm)
--   4. authz.require: unchanged, plus authz.require_mfa(perm) AFTER the permission check
--      (a non-holder still gets PERMISSION_DENIED; MFA status is never revealed to them)
--   5. api.v_permissions gains requires_mfa (appended column)
--   6. api.my_mfa_status(): what the account page shows (switch, session aal, my gated permissions)
--
-- authz.require is called from every command, including ones that check a DIFFERENT permission
-- than the sensitive one (e.g. inventory.assert_quarantine_release checks scope directly). Those
-- commands must call authz.require_mfa(perm) themselves; see docs/AUTHORIZATION.md §6.7.

-- ---------------------------------------------------------------------------
-- 1. Flag
-- ---------------------------------------------------------------------------
alter table authz.permissions add column if not exists requires_mfa boolean not null default false;
comment on column authz.permissions.requires_mfa is
  'Exercising this permission needs an aal2 session (verified TOTP) when security.mfa_enforced is true';

-- The sensitive set. Codes that do not exist (yet) are simply not updated: admin.import.run is
-- added by the imports module, whose migration must set requires_mfa = true itself if it runs
-- after this one.
update authz.permissions set requires_mfa = true
where code in (
  'finance.payment.reverse',        -- payment reversal / bounce
  'admin.role.assign',              -- grant and revoke roles
  'admin.role.manage',              -- create roles, set role permissions
  'admin.override.manage',          -- per-user grant/deny overrides (same power as a role grant)
  'admin.user.suspend',             -- suspend and reactivate users
  'catalog.price.manage',           -- price lists and customer price lists
  'finance.credit_limit.change',    -- customer credit limits
  'inventory.quarantine.release',   -- stock out of quarantine (D-13)
  'admin.import.run'                -- bulk imports (if present)
);

-- ---------------------------------------------------------------------------
-- 2. Switch (owner-controlled; audited because core.system_settings is audited)
-- ---------------------------------------------------------------------------
insert into core.system_settings (key, value, description) values
  ('security.mfa_enforced', 'false',
   'When true, permissions flagged requires_mfa need a session verified with a second factor (aal2)')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Helpers (internal; never client-callable)
-- ---------------------------------------------------------------------------
-- The session's authenticator assurance level, read from the JWT claims exactly as Supabase's
-- auth.jwt() reads them. NULL when there is no claim (treated as not aal2).
create or replace function authz.session_aal() returns text
language sql stable set search_path = '' as $$
  select (coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                   nullif(current_setting('request.jwt.claims', true), ''))::jsonb) ->> 'aal'
$$;

-- Is the MFA switch on? Only the JSON value true (or the string "true") turns it on.
create or replace function authz.mfa_enforced() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.value #>> '{}' = 'true' from core.system_settings s
                    where s.key = 'security.mfa_enforced'), false)
$$;

-- Raise MFA_REQUIRED when the switch is on, the permission requires MFA and the session is not
-- aal2. Applies to owners too. Commands that gate a sensitive action without authz.require on
-- that permission call this directly.
create or replace function authz.require_mfa(p_perm text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if authz.mfa_enforced()
     and exists (select 1 from authz.permissions p where p.code = p_perm and p.requires_mfa)
     and authz.session_aal() is distinct from 'aal2' then
    raise exception 'MFA_REQUIRED: % needs a session verified with your authenticator app', p_perm
      using errcode = '42501';
  end if;
end $$;

revoke execute on function authz.session_aal() from public, anon, authenticated;
revoke execute on function authz.mfa_enforced() from public, anon, authenticated;
revoke execute on function authz.require_mfa(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. authz.require — from 20261028000500_authz.sql (its only definition). Change: the MFA
--    step-up check after the permission check. CREATE OR REPLACE keeps its privileges.
-- ---------------------------------------------------------------------------
create or replace function authz.require(p_perm text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.has_permission(p_perm) then
    raise exception 'PERMISSION_DENIED: %', p_perm using errcode = '42501';
  end if;
  perform authz.require_mfa(p_perm);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Permission catalogue view — from 20261028001400_platform_admin.sql; requires_mfa appended.
-- ---------------------------------------------------------------------------
create or replace view api.v_permissions with (security_invoker = true) as
  select code, module, description, allowed_scopes, supports_limit, is_sensitive, requires_mfa
  from authz.permissions;

-- ---------------------------------------------------------------------------
-- 6. The caller's MFA status (account page). Read-only; reveals only the caller's own grants.
-- ---------------------------------------------------------------------------
create or replace function api.my_mfa_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'enforced', authz.mfa_enforced(),
    'aal', authz.session_aal(),
    'required_permissions', coalesce((
      select jsonb_agg(p.code order by p.code)
      from authz.permissions p
      where p.requires_mfa and authz.has_permission(p.code)), '[]'::jsonb))
$$;

revoke execute on function api.my_mfa_status() from public, anon;
grant execute on function api.my_mfa_status() to authenticated;
