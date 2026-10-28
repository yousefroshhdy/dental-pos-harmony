-- =============================================================================
-- TEST-ONLY. Never apply to a Supabase project.
-- Recreates the minimum of Supabase's environment on plain PostgreSQL 16 so the
-- migrations and RLS tests run without Docker: auth schema, auth.uid(), the
-- anon / authenticated / service_role roles, and the extensions schema.
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;

create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create schema if not exists auth;
create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique
);

-- Same contract as Supabase: the user id is the `sub` claim of the request JWT.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
