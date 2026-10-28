-- Views must never bypass RLS (regression test for the plain-view balance leak).
begin;
select tests.load_fixture();
select plan(5);

select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind = 'v'
             and n.nspname in ('api','core','authz','catalog','inventory','crm','field','work','sales',
                               'finance','perf','wf','audit','notify','integration','service')
             and not coalesce(c.reloptions @> array['security_invoker=true'], false)),
          0, 'every application view is security_invoker');

-- A balance for the Delta customer (rep a5) and one for the Cairo customer (rep a4)
insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id) values
  ('40000000-0000-0000-0000-000000000002', 'opening_balance', 5000, 'import', gen_random_uuid()),
  ('40000000-0000-0000-0000-000000000001', 'opening_balance', 1200, 'import', gen_random_uuid());

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from finance.v_customer_balances
           where customer_id = '40000000-0000-0000-0000-000000000002'), 0,
  'a rep cannot read another territory''s customer balance through finance views');
select is((select count(*)::int from inventory.v_stock), 0,
  'inventory view follows stock RLS (no balances posted for this rep''s scope)');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from finance.v_customer_balances), 2, 'finance (ledger read, all) sees both balances');
select tests.clear_authentication();

-- Definer commands still read through the views (owner context)
select is((select balance from finance.v_customer_balances where customer_id = '40000000-0000-0000-0000-000000000002'),
          5000.00::numeric(14,2), 'owner context (definer functions) still sees balances');

select * from finish();
rollback;
