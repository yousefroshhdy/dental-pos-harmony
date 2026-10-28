-- Honest OS migration: extensions, schemas, shared helpers
-- Origin: docs/database/draft/10_schema_draft.sql (Phase 1, validated). See docs/DATABASE.md.

-- Supabase installs extensions into the `extensions` schema; we do the same so
-- the local test stub and Supabase behave identically.
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists citext  with schema extensions;

create schema if not exists core;
create schema if not exists authz;
create schema if not exists catalog;
create schema if not exists inventory;
create schema if not exists crm;
create schema if not exists field;
create schema if not exists work;
create schema if not exists sales;
create schema if not exists finance;
create schema if not exists perf;
create schema if not exists wf;
create schema if not exists audit;
create schema if not exists notify;
create schema if not exists integration;
create schema if not exists api;

-- Functions are executable by PUBLIC by default, and a schema-scoped
-- ALTER DEFAULT PRIVILEGES cannot revoke that global default. RULE: every
-- migration that creates `api` functions ends with
--   revoke execute on all functions in schema api from public;
--   grant  execute on all functions in schema api to authenticated;
-- supabase/tests/database/08_* fails if any api function is executable by anon.

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------
create or replace function core.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function core.forbid_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'APPEND_ONLY: % on %.% is not allowed; post a reversing entry instead',
    tg_op, tg_table_schema, tg_table_name using errcode = 'P0001';
end $$;

-- Great-circle distance in metres (haversine). Accurate to well under 1 m at
-- geofence scale; avoids a PostGIS dependency for the MVP (ADR-011).
create or replace function core.distance_m(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
returns numeric language sql immutable parallel safe set search_path = '' as $$
  select (2 * 6371008.8 * asin(sqrt(
            power(sin(radians((lat2 - lat1)::float8) / 2), 2) +
            cos(radians(lat1::float8)) * cos(radians(lat2::float8)) *
            power(sin(radians((lng2 - lng1)::float8) / 2), 2))))::numeric(12,1)
$$;

-- Egyptian numbers stored as E.164. Mobile: +20 1[0125] + 8 digits.
-- Landline: +20 + area code + number (8–9 national digits after +20).
create domain core.phone_e164 as text
  check (value ~ '^\+20(1[0125][0-9]{8}|[2-9][0-9]{7,8})$');

create domain core.money as numeric(14,2);
