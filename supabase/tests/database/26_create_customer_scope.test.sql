-- Follow-up to the 2026-10-30 audit, F7: api.create_customer must not reveal a
-- customer the caller cannot read, through its hard-duplicate error or its
-- soft-duplicate warning. Fixture: rep a4 (Cairo) cannot read C-0002 (Delta,
-- +201112345678, "Dr. Mona Clinic", EG-DK); rep a5 (Delta) can.
begin;
select tests.load_fixture();
select plan(7);

create function pg_temp.dup_error(p_phone text) returns jsonb language plpgsql as $$
declare v_msg text; v_detail text;
begin
  perform api.create_customer(p_clinic_name => 'Synthetic Test Clinic', p_phone_primary => p_phone, p_governorate_code => 'EG-C');
  return jsonb_build_object('raised', false);
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  return jsonb_build_object('raised', true, 'message', v_msg, 'detail', coalesce(v_detail, ''));
end $$;

-- Hard duplicate, caller outside scope: no customer number anywhere.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select set_config('t.hidden', pg_temp.dup_error('01112345678')::text, true);
select ok((current_setting('t.hidden')::jsonb ->> 'message') like 'DUPLICATE_CUSTOMER:%outside your scope',
  'an out-of-scope phone match is still a hard duplicate');
select ok(position('C-0002' in current_setting('t.hidden')) = 0,
  'neither the message nor the detail names the out-of-scope customer');
select is((current_setting('t.hidden')::jsonb ->> 'detail')::jsonb ->> 'outside_scope', 'true',
  'the detail flags the match as outside the caller''s scope');

-- Hard duplicate, caller in scope: the number is still given.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select ok((pg_temp.dup_error('01112345678') ->> 'message') like 'DUPLICATE_CUSTOMER:%C-0002',
  'a rep who can read the customer is told its number');

-- Soft duplicate (similar name, same governorate), caller outside scope.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select set_config('t.soft', api.create_customer(p_clinic_name => 'Dr. Mona Clinic', p_phone_primary => '01099990001',
  p_governorate_code => 'EG-DK', p_client_ref => 'c2600000-0000-0000-0000-000000000001')::text, true);
select is(current_setting('t.soft')::jsonb #> '{warnings,0,customer_nos}', '[]'::jsonb,
  'a similar out-of-scope customer is not named in the warning');
select is(current_setting('t.soft')::jsonb #>> '{warnings,0,outside_scope}', 'true',
  'the warning says a similar customer exists outside the caller''s scope');

-- Soft duplicate, caller in scope: named as before.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select ok(api.create_customer(p_clinic_name => 'Dr. Mona Clinic', p_phone_primary => '01099990002',
  p_governorate_code => 'EG-DK', p_client_ref => 'c2600000-0000-0000-0000-000000000002') #> '{warnings,0,customer_nos}' ? 'C-0002',
  'a rep who can read the similar customer sees its number');

select * from finish();
rollback;
