-- Outbox dispatcher: service-schema privileges, claim/route/skip, delivery
-- outcomes and backoff, dead letters, crash recovery, admin retry and views.
--
-- Not covered here: FOR UPDATE SKIP LOCKED between two concurrent dispatchers
-- needs two sessions holding open transactions; a single-session pgTAP file
-- cannot observe it. The clause is in service.outbox_claim (reviewed by hand).
begin;
select tests.load_fixture();
select plan(58);

-- ---------------------------------------------------------------------------
-- Privilege surface of the `service` schema
-- ---------------------------------------------------------------------------
select ok(not has_schema_privilege('authenticated', 'service', 'usage'), 'authenticated cannot use schema service');
select ok(not has_schema_privilege('anon', 'service', 'usage'), 'anon cannot use schema service');
select ok(has_schema_privilege('service_role', 'service', 'usage'), 'service_role can use schema service');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'service'
             and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
          0, 'no service function is executable by anon or authenticated');
select ok(has_function_privilege('service_role', 'service.outbox_claim(integer)', 'execute')
          and has_function_privilege('service_role', 'service.outbox_result(uuid, boolean, integer, text)', 'execute'),
          'service_role can execute the dispatcher functions');
select ok(not has_column_privilege('authenticated', 'integration.outbox', 'payload', 'select'),
          'authenticated has no access to outbox payloads');
select ok(not exists (select 1 from information_schema.role_table_grants
                      where grantee in ('authenticated', 'anon') and table_schema = 'integration'
                        and privilege_type in ('INSERT', 'UPDATE', 'DELETE')),
          'no client role can write integration tables');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_ok($$select * from service.outbox_claim(10)$$, '42501', null, 'even an admin user cannot call outbox_claim');
select throws_ok($$select service.outbox_result('b0000000-0000-0000-0000-000000000001', true, 200, null)$$, '42501', null,
                 'an app user cannot call outbox_result');
select tests.authenticate_anon();
select throws_ok($$select * from service.outbox_claim(10)$$, '42501', null, 'anon cannot call outbox_claim');
select tests.clear_authentication();

-- ---------------------------------------------------------------------------
-- Routes
-- ---------------------------------------------------------------------------
insert into integration.routes (event_pattern, target_url, description, is_active) values
  ('order.%',         'https://a.example.test/orders',    'all order events', true),
  ('order.submitted', 'https://b.example.test/submitted', 'submissions only', true),
  ('invoice.%',       'https://c.example.test/invoices',  'disabled',         false);
select throws_ok($$insert into integration.routes (event_pattern, target_url) values ('order.%', 'http://example.com/hook')$$,
                 '23514', null, 'plain http targets are rejected');
select lives_ok($$insert into integration.routes (event_pattern, target_url, is_active) values ('dev.%', 'http://localhost:3000/hook', true)$$,
                'http://localhost targets are allowed for development');
select is((select count(*)::int from audit.audit_log where table_schema = 'integration' and table_name = 'routes'), 4,
          'route changes are audited');

-- ---------------------------------------------------------------------------
-- Outbox fixture (ids b0…0n)
--   e1 order.submitted  → routes a + b          e5 order.rejected  stuck in_flight 11 min (attempts 2)
--   e2 order.approved   → route a               e6 order.cancelled in_flight 2 min (live lease)
--   e3 invoice.issued   → only inactive route   e8 order.pending_approval → backoff sequence
--   e4 order.fulfilled  → not due yet           e9 order.reopened → 429 + long error
-- ---------------------------------------------------------------------------
insert into integration.outbox (id, event_type, aggregate_type, aggregate_id, payload, status, attempts,
                                next_attempt_at, claimed_at, created_at) values
  ('b0000000-0000-0000-0000-000000000001','order.submitted','order',gen_random_uuid(),'{"n":1}','pending',0,now(),null,now() - interval '5 minutes'),
  ('b0000000-0000-0000-0000-000000000002','order.approved','order',gen_random_uuid(),'{"n":2}','pending',0,now(),null,now() - interval '4 minutes'),
  ('b0000000-0000-0000-0000-000000000003','invoice.issued','invoice',gen_random_uuid(),'{"n":3}','pending',0,now(),null,now() - interval '3 minutes'),
  ('b0000000-0000-0000-0000-000000000004','order.fulfilled','order',gen_random_uuid(),'{"n":4}','failed',1,now() + interval '1 minute',null,now() - interval '9 minutes'),
  ('b0000000-0000-0000-0000-000000000005','order.rejected','order',gen_random_uuid(),'{"n":5}','in_flight',2,now(),now() - interval '11 minutes',now() - interval '10 minutes'),
  ('b0000000-0000-0000-0000-000000000006','order.cancelled','order',gen_random_uuid(),'{"n":6}','in_flight',0,now(),now() - interval '2 minutes',now() - interval '8 minutes'),
  ('b0000000-0000-0000-0000-000000000008','order.pending_approval','order',gen_random_uuid(),'{"n":8}','pending',0,now(),null,now() - interval '2 minutes'),
  ('b0000000-0000-0000-0000-000000000009','order.reopened','order',gen_random_uuid(),'{"n":9}','pending',0,now(),null,now() - interval '1 minute');

create temp table claimed (id uuid, event_type text, aggregate_type text, aggregate_id uuid, payload jsonb,
                           attempts int, created_at timestamptz, targets text[]);
grant all on claimed to service_role;

-- ---------------------------------------------------------------------------
-- Claim (as the service role, exactly like the cron route)
-- ---------------------------------------------------------------------------
set local role service_role;
insert into claimed select * from service.outbox_claim(1);
reset role;
select is((select array_agg(id) from claimed), array['b0000000-0000-0000-0000-000000000005']::uuid[],
          'p_limit is honoured and the oldest due event (the recovered one) comes first');
select is((select attempts from integration.outbox where id = 'b0000000-0000-0000-0000-000000000005'), 3,
          'a stuck in_flight row counts one failed attempt on recovery');
select ok((select last_error like 'LEASE_EXPIRED%' from integration.outbox where id = 'b0000000-0000-0000-0000-000000000005'),
          'recovery records why the row was released');
select is((select status from integration.outbox where id = 'b0000000-0000-0000-0000-000000000005'), 'in_flight',
          'the recovered row is claimed again');
select is((select status from integration.outbox where id = 'b0000000-0000-0000-0000-000000000006'), 'in_flight',
          'a live in_flight lease (2 min) is left alone');

truncate claimed;
set local role service_role;
insert into claimed select * from service.outbox_claim(100);
reset role;
select is((select array_agg(id order by id) from claimed),
          array['b0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000002',
                'b0000000-0000-0000-0000-000000000008','b0000000-0000-0000-0000-000000000009']::uuid[],
          'claim returns exactly the due, routable events');
select is((select targets from claimed where id = 'b0000000-0000-0000-0000-000000000001'),
          array['https://a.example.test/orders','https://b.example.test/submitted'],
          'an event matching two routes gets both targets');
select is((select targets from claimed where id = 'b0000000-0000-0000-0000-000000000002'),
          array['https://a.example.test/orders'], 'LIKE pattern routing picks only matching routes');
select is((select payload from claimed where id = 'b0000000-0000-0000-0000-000000000001'), '{"n":1}'::jsonb,
          'claim returns the payload to the dispatcher');
select ok((select bool_and(status = 'in_flight' and claimed_at = now()) from integration.outbox
           where id in (select id from claimed)), 'claimed rows are marked in_flight with a lease time');
select is((select status from integration.outbox where id = 'b0000000-0000-0000-0000-000000000003'), 'skipped',
          'an event whose only route is inactive is skipped');
select ok((select last_error like 'NO_ROUTE%' and claimed_at is null from integration.outbox
           where id = 'b0000000-0000-0000-0000-000000000003'), 'a skipped event records why');
select is((select status from integration.outbox where id = 'b0000000-0000-0000-0000-000000000004'), 'failed',
          'an event whose next attempt is in the future is not claimed');
select is((select count(*)::int from service.outbox_claim(100)), 0, 'a second claim finds nothing left to do');

-- ---------------------------------------------------------------------------
-- Results
-- ---------------------------------------------------------------------------
set local role service_role;
select is(service.outbox_result('b0000000-0000-0000-0000-000000000001', true, 200, null), 'delivered', 'a 2xx delivers the event');
reset role;
select ok((select status = 'delivered' and delivered_at = now() and claimed_at is null and attempts = 0
           from integration.outbox where id = 'b0000000-0000-0000-0000-000000000001'), 'delivered_at is stamped');
select throws_like($$select service.outbox_result('b0000000-0000-0000-0000-000000000001', false, 500, 'late')$$,
                   'INVALID_STATE%', 'a result for an event that is no longer in_flight is refused');
select throws_ok($$select service.outbox_result('b0000000-0000-0000-0000-0000000000ff', true, 200, null)$$,
                 'P0002', null, 'a result for an unknown event is NOT_FOUND');

select is(service.outbox_result('b0000000-0000-0000-0000-000000000002', false, 404, 'Not Found'), 'dead',
          'a 404 is a contract problem: dead immediately');
select ok((select attempts = 1 and last_error = 'HTTP 404: Not Found' from integration.outbox
           where id = 'b0000000-0000-0000-0000-000000000002'), '404 records the attempt and the error');

select is(service.outbox_result('b0000000-0000-0000-0000-000000000009', false, 429, repeat('x', 2000)), 'failed',
          'a 429 is retried, not dead');
select ok((select next_attempt_at = now() + interval '1 minute' and length(last_error) = 1000
           from integration.outbox where id = 'b0000000-0000-0000-0000-000000000009'),
          '429 waits 1 minute and last_error is truncated to 1000 characters');

select is(service.outbox_result('b0000000-0000-0000-0000-000000000005', false, null, 'TIMEOUT: no response within 10 s'), 'failed',
          'a timeout is retried');
select ok((select attempts = 4 and next_attempt_at = now() + interval '2 hours' and last_error = 'TIMEOUT: no response within 10 s'
           from integration.outbox where id = 'b0000000-0000-0000-0000-000000000005'),
          'the 4th failure waits 2 hours');

-- Backoff sequence for e8: fail, make it due again, re-claim, fail again …
create function pg_temp.fail_again(p_id uuid, p_http int) returns text language plpgsql as $$
begin
  update integration.outbox set next_attempt_at = now() where id = p_id and status = 'failed';
  perform 1 from service.outbox_claim(100) c where c.id = p_id;
  return service.outbox_result(p_id, false, p_http, 'Service Unavailable');
end $$;

select is(service.outbox_result('b0000000-0000-0000-0000-000000000008', false, 503, 'Service Unavailable'), 'failed',
          '1st 5xx failure is retried');
select is((select next_attempt_at from integration.outbox where id = 'b0000000-0000-0000-0000-000000000008'),
          now() + interval '1 minute', '1st failure waits 1 minute');
select is(pg_temp.fail_again('b0000000-0000-0000-0000-000000000008', 500), 'failed', '2nd failure is retried');
select is((select next_attempt_at from integration.outbox where id = 'b0000000-0000-0000-0000-000000000008'),
          now() + interval '5 minutes', '2nd failure waits 5 minutes');
select is(pg_temp.fail_again('b0000000-0000-0000-0000-000000000008', 502), 'failed', '3rd failure is retried');
select is((select next_attempt_at from integration.outbox where id = 'b0000000-0000-0000-0000-000000000008'),
          now() + interval '30 minutes', '3rd failure waits 30 minutes');
select is(pg_temp.fail_again('b0000000-0000-0000-0000-000000000008', 408), 'failed', '4th failure (408) is retried');
select is(pg_temp.fail_again('b0000000-0000-0000-0000-000000000008', 503), 'failed', '5th failure is retried');
select is((select next_attempt_at from integration.outbox where id = 'b0000000-0000-0000-0000-000000000008'),
          now() + interval '12 hours', '5th failure waits 12 hours');
select is(pg_temp.fail_again('b0000000-0000-0000-0000-000000000008', 503), 'dead', '6th failure is dead');
select is((select attempts from integration.outbox where id = 'b0000000-0000-0000-0000-000000000008'), 6,
          'a dead letter keeps its attempt count');

-- ---------------------------------------------------------------------------
-- Admin surface
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');   -- sales rep
select throws_like($$select api.retry_outbox_event('b0000000-0000-0000-0000-000000000002')$$, 'PERMISSION_DENIED%',
                   'a rep cannot retry outbox events');
select is((select count(*)::int from api.v_outbox_dead) + (select count(*)::int from api.v_outbox_health)
          + (select count(*)::int from api.v_integration_routes), 0, 'a rep sees no outbox health, dead letters or routes');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');   -- admin
select is((select array_agg(id order by id) from api.v_outbox_dead where status = 'dead'),
          array['b0000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000008']::uuid[],
          'the admin sees the dead letters');
select is((select event_count from api.v_outbox_health where status = 'dead'), 2, 'health view counts dead letters');
select is((select count(*)::int from api.v_integration_routes), 4, 'the admin sees every route');
select throws_ok($$select payload from integration.outbox$$, '42501', null, 'the admin cannot read payloads directly');
select throws_like($$select api.retry_outbox_event('b0000000-0000-0000-0000-000000000001')$$, 'INVALID_STATE%',
                   'a delivered event cannot be retried');
select lives_ok($$select api.retry_outbox_event('b0000000-0000-0000-0000-000000000002')$$, 'the admin retries a dead letter');
select tests.clear_authentication();
select ok((select status = 'pending' and attempts = 0 and next_attempt_at = now() and claimed_at is null
           from integration.outbox where id = 'b0000000-0000-0000-0000-000000000002'), 'retry resets the event to pending');
select is((select count(*)::int from audit.security_events
           where event_type = 'outbox_retry' and user_id = '00000000-0000-0000-0000-0000000000a7'
             and details ->> 'event_id' = 'b0000000-0000-0000-0000-000000000002'
             and details ->> 'previous_status' = 'dead'), 1, 'the retry is logged as a security event');

select * from finish();
rollback;
