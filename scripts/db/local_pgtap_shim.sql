-- =============================================================================
-- TEST-ONLY pgTAP-compatible shim for plain PostgreSQL (local runs only).
--
-- Supabase ships real pgTAP (`supabase test db`). This environment cannot
-- install it, so this file implements the small subset our tests use, with the
-- same names and TAP output: plan, ok, is, isnt, throws_like, throws_ok,
-- lives_ok, finish. Tests written against it run unchanged on real pgTAP.
-- =============================================================================
create or replace function extensions._tap_next() returns int language sql as $$
  select set_config('tap.n', (coalesce(nullif(current_setting('tap.n', true), ''), '0')::int + 1)::text, false)::int
$$;
create or replace function extensions._tap_fail() returns void language sql as $$
  select set_config('tap.failed', (coalesce(nullif(current_setting('tap.failed', true), ''), '0')::int + 1)::text, false);
$$;

create or replace function extensions.plan(p_count int) returns text language plpgsql as $$
begin
  perform set_config('tap.n', '0', false);
  perform set_config('tap.failed', '0', false);
  perform set_config('tap.planned', p_count::text, false);
  return '1..' || p_count;
end $$;

create or replace function extensions.ok(p_ok boolean, p_desc text default '') returns text
language plpgsql as $$
declare n int := extensions._tap_next();
begin
  if coalesce(p_ok, false) then return 'ok ' || n || ' - ' || p_desc; end if;
  perform extensions._tap_fail();
  return 'not ok ' || n || ' - ' || p_desc;
end $$;

create or replace function extensions.is(p_have anyelement, p_want anyelement, p_desc text default '') returns text
language plpgsql as $$
declare r text := extensions.ok(p_have is not distinct from p_want, p_desc);
begin
  if r like 'not ok%' then
    return r || E'\n#   have: ' || coalesce(p_have::text, 'NULL') || E'\n#   want: ' || coalesce(p_want::text, 'NULL');
  end if;
  return r;
end $$;

create or replace function extensions.isnt(p_have anyelement, p_want anyelement, p_desc text default '') returns text
language sql as $$ select extensions.ok(p_have is distinct from p_want, p_desc) $$;

-- throws_like(sql, like_pattern, description): passes when sql raises and SQLERRM LIKE pattern.
create or replace function extensions.throws_like(p_sql text, p_like text, p_desc text default '') returns text
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm like p_like then return extensions.ok(true, p_desc); end if;
    return extensions.ok(false, p_desc) || E'\n#   caught: ' || sqlerrm || E'\n#   wanted: ' || p_like;
  end;
  return extensions.ok(false, p_desc) || E'\n#   no exception raised';
end $$;

-- throws_ok(sql, errcode, errmsg, description): errmsg NULL = any message.
create or replace function extensions.throws_ok(p_sql text, p_errcode text, p_errmsg text, p_desc text default '') returns text
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_errcode and (p_errmsg is null or sqlerrm = p_errmsg) then return extensions.ok(true, p_desc); end if;
    return extensions.ok(false, p_desc) || E'\n#   caught: ' || sqlstate || ' ' || sqlerrm;
  end;
  return extensions.ok(false, p_desc) || E'\n#   no exception raised';
end $$;

create or replace function extensions.lives_ok(p_sql text, p_desc text default '') returns text
language plpgsql as $$
begin
  execute p_sql;
  return extensions.ok(true, p_desc);
exception when others then
  return extensions.ok(false, p_desc) || E'\n#   died: ' || sqlerrm;
end $$;

create or replace function extensions.finish() returns setof text language plpgsql as $$
declare n int := coalesce(nullif(current_setting('tap.n', true), ''), '0')::int;
        planned int := coalesce(nullif(current_setting('tap.planned', true), ''), '0')::int;
        failed int := coalesce(nullif(current_setting('tap.failed', true), ''), '0')::int;
begin
  if n <> planned then return next '# Looks like you planned ' || planned || ' tests but ran ' || n; end if;
  if failed > 0 then return next '# Looks like you failed ' || failed || ' test(s) of ' || n; end if;
  return;
end $$;

grant execute on all functions in schema extensions to anon, authenticated;
