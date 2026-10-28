-- Honest OS migration: transactional-outbox dispatcher (Phase 2, roadmap task 8)
-- Design: docs/INTEGRATIONS.md §3, docs/ARCHITECTURE.md §8.5, docs/API_CONTRACTS.md §4–§5 (ADR-016).
--
--   integration.routes          event_type LIKE pattern → target URL (admin-managed config)
--   service.outbox_claim()      claim due rows (FOR UPDATE SKIP LOCKED), lease them as in_flight
--   service.outbox_result()     record one delivery outcome: delivered / failed + backoff / dead
--   api.retry_outbox_event()    admin re-queues a failed or dead event
--   api.v_outbox_health, api.v_outbox_dead, api.v_integration_routes   admin read views
--
-- All changes are additive (expand only): one new schema, one new table, one new
-- nullable column, and a widened status CHECK (adds 'skipped'; no value removed).

-- ---------------------------------------------------------------------------
-- `service` schema: callable only by the server's service-role client
-- (src/lib/supabase/admin.ts). Never granted to anon/authenticated.
-- ---------------------------------------------------------------------------
create schema if not exists service;
revoke all on schema service from public;
grant usage on schema service to service_role;
-- Functions get EXECUTE-to-PUBLIC by default and a schema-scoped ALTER DEFAULT
-- PRIVILEGES cannot remove that. RULE: every migration that creates `service`
-- functions ends with the revoke/grant pair at the bottom of this file
-- (supabase/tests/database/09_outbox.test.sql checks it). Without schema USAGE
-- anon/authenticated cannot reach them anyway; the revoke is defence in depth.

-- ---------------------------------------------------------------------------
-- Outbox: 'skipped' status (no active route) and the in_flight lease timestamp
-- ---------------------------------------------------------------------------
alter table integration.outbox drop constraint if exists outbox_status_check;
alter table integration.outbox add constraint outbox_status_check
  check (status in ('pending','in_flight','delivered','failed','dead','skipped'));

-- When the row was claimed; drives crash recovery of stuck in_flight rows.
alter table integration.outbox add column if not exists claimed_at timestamptz;
create index if not exists outbox_in_flight_claimed_idx on integration.outbox (claimed_at) where status = 'in_flight';
create index if not exists outbox_problem_idx on integration.outbox (created_at desc) where status in ('failed','dead');

-- ---------------------------------------------------------------------------
-- Routes: which consumer(s) receive which events
-- ---------------------------------------------------------------------------
create table integration.routes (
  id            uuid primary key default gen_random_uuid(),
  event_pattern text not null check (event_pattern ~ '^[a-z0-9_.%]+$'),   -- SQL LIKE pattern, e.g. 'order.%'
  target_url    text not null check (
                  target_url ~ '^https://[^\s/?#]+[^\s]*$'
                  or target_url ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(/[^\s]*)?$'),  -- plain http only for local dev
  description   text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (event_pattern, target_url)
);
comment on table integration.routes is
  'Outbox routing. event_type LIKE event_pattern → POST signed event to target_url. Note "_" in a pattern matches any one character.';
alter table integration.routes enable row level security;
-- A changed target URL redirects business events: keep its history.
create trigger trg_audit after insert or update or delete on integration.routes
  for each row execute function audit.log_change();

-- ---------------------------------------------------------------------------
-- service.outbox_claim: lease up to p_limit due events and return them with targets
-- ---------------------------------------------------------------------------
create or replace function service.outbox_claim(p_limit int default 100)
returns table (id uuid, event_type text, aggregate_type text, aggregate_id uuid, payload jsonb,
               attempts int, created_at timestamptz, targets text[])
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  -- 1. Crash recovery: a dispatcher that died mid-run leaves rows in_flight. After
  --    a 10-minute lease they count as one failed attempt (so a poison event that
  --    crashes the dispatcher still ends up dead) and become due again.
  update integration.outbox o
     set status          = case when o.attempts + 1 >= 6 then 'dead' else 'failed' end,
         attempts        = o.attempts + 1,
         last_error      = 'LEASE_EXPIRED: in_flight for more than 10 minutes',
         next_attempt_at = now(),
         claimed_at      = null
   where o.status = 'in_flight'
     and o.claimed_at < now() - interval '10 minutes';

  -- 2. Claim due rows. SKIP LOCKED lets overlapping cron runs share the queue
  --    without double delivery. Rows with no active route are closed as 'skipped'.
  return query
  with picked as (
    select o.id, o.event_type
      from integration.outbox o
     where o.status in ('pending','failed')
       and o.next_attempt_at <= now()
     order by o.created_at
     limit v_limit
       for update of o skip locked
  ), routed as (
    select p.id,
           (select array_agg(distinct r.target_url order by r.target_url)
              from integration.routes r
             where r.is_active and p.event_type like r.event_pattern) as targets
      from picked p
  ), upd as (
    update integration.outbox o
       set status     = case when rt.targets is null then 'skipped' else 'in_flight' end,
           claimed_at = case when rt.targets is null then null else now() end,
           last_error = case when rt.targets is null then 'NO_ROUTE: no active route matched' else o.last_error end
      from routed rt
     where o.id = rt.id
    returning o.id, o.event_type, o.aggregate_type, o.aggregate_id, o.payload, o.attempts, o.created_at, rt.targets
  )
  select u.id, u.event_type, u.aggregate_type, u.aggregate_id, u.payload, u.attempts, u.created_at, u.targets
    from upd u
   where u.targets is not null
   order by u.created_at;
end $$;

-- ---------------------------------------------------------------------------
-- service.outbox_result: record the outcome of delivering one claimed event
--   ok                                  → delivered
--   4xx except 408/429 (contract issue) → dead immediately
--   anything else (5xx, 408, 429, timeout, network)
--                                       → failed, retry after 1m, 5m, 30m, 2h, 12h; 6th failure → dead
-- Returns the new status.
-- ---------------------------------------------------------------------------
create or replace function service.outbox_result(p_id uuid, p_ok boolean, p_http_status int default null,
                                                 p_error text default null)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_row       integration.outbox%rowtype;
  v_attempts  int;
  v_permanent boolean;
  v_status    text;
  v_backoff   constant interval[] := array['1 minute','5 minutes','30 minutes','2 hours','12 hours']::interval[];
begin
  if p_ok is null then
    raise exception 'VALIDATION: p_ok is required' using errcode = 'P0001';
  end if;
  select * into v_row from integration.outbox where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: outbox event %', p_id using errcode = 'P0002';
  end if;
  if v_row.status <> 'in_flight' then
    raise exception 'INVALID_STATE: outbox event % is %, not in_flight', p_id, v_row.status using errcode = 'P0001';
  end if;

  if p_ok then
    update integration.outbox
       set status = 'delivered', delivered_at = now(), claimed_at = null
     where id = p_id;
    return 'delivered';
  end if;

  v_attempts  := v_row.attempts + 1;
  v_permanent := p_http_status between 400 and 499 and p_http_status not in (408, 429);
  v_status    := case when v_permanent or v_attempts >= 6 then 'dead' else 'failed' end;

  update integration.outbox
     set status          = v_status,
         attempts        = v_attempts,
         claimed_at      = null,
         next_attempt_at = case when v_status = 'failed' then now() + v_backoff[v_attempts] else next_attempt_at end,
         last_error      = left(coalesce(nullif(concat_ws(': ',
                             case when p_http_status is not null then 'HTTP ' || p_http_status end,
                             nullif(btrim(p_error), '')), ''), 'DELIVERY_FAILED'), 1000)
   where id = p_id;
  return v_status;
end $$;

-- ---------------------------------------------------------------------------
-- Admin surface (api): retry + read views, gated by admin.integration.manage
-- ---------------------------------------------------------------------------
create or replace function api.retry_outbox_event(p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_row integration.outbox%rowtype;
begin
  perform authz.require('admin.integration.manage');
  select * into v_row from integration.outbox where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: outbox event' using errcode = 'P0002';
  end if;
  if v_row.status not in ('failed','dead') then
    raise exception 'INVALID_STATE: only failed or dead events can be retried (event is %)', v_row.status
      using errcode = 'P0001';
  end if;
  update integration.outbox
     set status = 'pending', attempts = 0, next_attempt_at = now(), claimed_at = null
   where id = p_id;
  perform authz.log_security_event('outbox_retry', 'warning',
    jsonb_build_object('event_id', p_id, 'event_type', v_row.event_type,
                       'previous_status', v_row.status, 'previous_attempts', v_row.attempts));
end $$;

-- Admins read the outbox through views only, and never its payload: column grant.
grant usage on schema integration to authenticated;
grant select (id, event_type, aggregate_type, status, attempts, next_attempt_at, last_error, created_at, delivered_at)
  on integration.outbox to authenticated;
grant select on integration.routes to authenticated;
create policy outbox_admin_select on integration.outbox for select to authenticated
  using ((select authz.has_permission('admin.integration.manage')));
create policy routes_admin_select on integration.routes for select to authenticated
  using ((select authz.has_permission('admin.integration.manage')));

-- One row per status present; non-admins get no rows (RLS).
create or replace view api.v_outbox_health with (security_invoker = true) as
  select o.status,
         count(*)::int                                            as event_count,
         min(o.created_at)                                        as oldest_created_at,
         floor(extract(epoch from now() - min(o.created_at)))::int as oldest_age_seconds,
         min(o.next_attempt_at) filter (where o.status in ('pending','failed')) as next_attempt_at
    from integration.outbox o
   group by o.status;

-- Dead letters and retrying events, without payloads.
create or replace view api.v_outbox_dead with (security_invoker = true) as
  select o.id, o.event_type, o.aggregate_type, o.status, o.attempts, o.last_error, o.next_attempt_at, o.created_at
    from integration.outbox o
   where o.status in ('failed','dead');

create or replace view api.v_integration_routes with (security_invoker = true) as
  select r.id, r.event_pattern, r.target_url, r.description, r.is_active, r.created_at
    from integration.routes r;

grant select on api.v_outbox_health, api.v_outbox_dead, api.v_integration_routes to authenticated;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
revoke all on all functions in schema service from public, anon, authenticated;
grant execute on all functions in schema service to service_role;

revoke execute on all functions in schema api from public;
grant execute on all functions in schema api to authenticated;
