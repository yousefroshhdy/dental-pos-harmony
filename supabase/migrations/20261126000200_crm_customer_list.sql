-- Honest OS migration: Phase P step 2b (redesign of Today and CRM), read side.
--
--   api.v_customer_list   one row per live (not archived) customer for the redesigned customers
--                         list: the list columns of api.v_customers plus the data-gap flags
--                         (phone_missing, location_missing: same rules as api.v_customer_data_gaps)
--                         and the overdue-receivables flag (same rule as api.v_customer_map). One
--                         view, so the list can filter on "overdue" and "phone missing" together
--                         with search, stage, territory and rep, and still page and count on the
--                         server.
--
-- security_invoker: built on api.v_customers, so the caller's crm.customers RLS decides which
-- rows come back and the balance stays masked exactly as there. The overdue flag and amount are
-- masked the same way (NULL when the balance is masked). crm.customer_overdue_in_scope() is the
-- SECURITY DEFINER helper the customers map already uses (20261125000300).
--
-- Additive only: one new view, explicit grants. Tests: supabase/tests/database/61_phase_p_ui_crm.test.sql.

create or replace view api.v_customer_list with (security_invoker = true) as
  select v.id, v.customer_no, v.kind, v.display_name, v.doctor_name, v.clinic_name, v.specialty_code,
         v.lifecycle_stage, v.source, v.phone_primary, v.phone_secondary, v.city, v.governorate_code,
         v.territory_id, v.territory_code, v.territory_name_en, v.territory_name_ar,
         v.primary_rep_employee_id, v.primary_rep_name_en, v.primary_rep_name_ar,
         v.latitude, v.longitude, v.location_verified,
         -- NULL = masked (no crm.customer_balance.read for this customer), as in api.v_customers.
         v.balance,
         (v.phone_primary is null) as phone_missing,
         (v.latitude is null) as location_missing,
         case when v.balance is not null then coalesce(od.overdue_amount, 0) > 0 end as is_overdue,
         case when v.balance is not null then coalesce(od.overdue_amount, 0)::numeric(14,2) end as overdue_amount,
         case when v.balance is not null then od.max_days_overdue end as max_days_overdue,
         v.created_at, v.updated_at
  from api.v_customers v
  left join crm.customer_overdue_in_scope() od on od.customer_id = v.id
  where v.archived_at is null;

comment on view api.v_customer_list is
  'Live customers for the CRM list: v_customers list columns, phone/location gap flags, overdue flag (masked like the balance).';

-- Privileges (explicit; the anon role never reads customers).
grant select on api.v_customer_list to authenticated;
revoke all on api.v_customer_list from anon;
