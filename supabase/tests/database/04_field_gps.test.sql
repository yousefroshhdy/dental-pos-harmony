-- Field visits: server-side GPS verification, idempotent replay, anomaly flags, scope.
begin;
select tests.load_fixture();
select plan(8);

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.visit_check_in('80000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',
  30.044800, 31.235700, 20, now(), '{}') ->> 'verification_status', 'verified', 'check-in ~45 m from the clinic is verified');
select is(api.visit_check_in('80000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',
  30.044800, 31.235700, 20, now(), '{}') ->> 'replayed', 'true', 'offline replay of the same visit id is idempotent');
select is(api.visit_check_in('80000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000001',
  30.064400, 31.235700, 20, now() + interval '1 minute', '{}') ->> 'verification_status', 'out_of_range', 'check-in ~2.2 km away is out_of_range');
select is(api.visit_check_in('80000000-0000-0000-0000-000000000003','40000000-0000-0000-0000-000000000001',
  30.044500, 31.235700, 350, now() + interval '2 minutes', '{}') ->> 'verification_status', 'low_accuracy', 'poor GPS accuracy is not silently verified');
select ok(api.visit_check_in('80000000-0000-0000-0000-000000000004','40000000-0000-0000-0000-000000000001',
  31.200000, 29.918700, 10, now() + interval '3 minutes', '{}') -> 'anomaly_flags' ? 'impossible_travel', 'Cairo → Alexandria in 1 minute is flagged impossible_travel');
select ok(api.visit_check_in('80000000-0000-0000-0000-000000000005','40000000-0000-0000-0000-000000000001',
  30.044800, 31.235700, 20, now() - interval '2 hours', '{}') -> 'anomaly_flags' ? 'late_sync', 'a fix synced 2 hours late is flagged late_sync');
select throws_like($$select api.visit_check_in('80000000-0000-0000-0000-000000000009','40000000-0000-0000-0000-000000000002', 31.0409, 31.3785, 10, now(), '{}')$$,
  'PERMISSION_DENIED%', 'rep cannot check in at a customer outside their scope');

-- Privacy: the Delta rep cannot read the Cairo rep's raw GPS fixes
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from field.location_events), 0, 'another rep cannot read raw GPS fixes');

select * from finish();
rollback;
