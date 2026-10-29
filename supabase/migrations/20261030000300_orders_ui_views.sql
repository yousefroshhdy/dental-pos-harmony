-- Honest OS migration: read views for the orders UI (Phase 3, task 9).
--
-- Additive only: two security_invoker views, no new functions, no table changes.
--   api.v_sellable_variants     — what the order builder may offer (active variant of an active product).
--                                 No prices, no costs: the builder sends only variant ids and quantities,
--                                 and every price comes back from api.save_order_draft / api.v_order_lines.
--   api.v_order_status_history  — an order's status timeline (sales.order_status_history had RLS but no
--                                 client view).
-- RLS of the underlying tables applies to the caller (catalog.product.read for the catalogue; the order's
-- own visibility for its history). Tests: supabase/tests/database/21_orders_ui.test.sql.

create or replace view api.v_sellable_variants with (security_invoker = true) as
  select v.id as variant_id, v.sku, v.name_en as variant_name, v.barcode, v.uom, v.attributes,
         p.id as product_id, p.code as product_code, p.name_en as product_name_en, p.name_ar as product_name_ar,
         b.code as brand_code, b.name as brand_name,
         c.code as category_code, c.name_en as category_name_en, c.name_ar as category_name_ar
  from catalog.product_variants v
  join catalog.products p on p.id = v.product_id
  left join catalog.brands b on b.id = p.brand_id
  left join catalog.categories c on c.id = p.category_id
  where v.status = 'active' and p.status = 'active';

-- changed_by is an auth user; the name comes from the employee linked to that user
-- (crm.employee_display: colleague names are not sensitive inside the company).
create or replace view api.v_order_status_history with (security_invoker = true) as
  select h.id, h.order_id, h.from_status, h.to_status, h.changed_at, h.reason, h.changed_by,
         (h.changed_by = (select auth.uid())) as is_mine,
         emp.full_name_en as changed_by_name_en, emp.full_name_ar as changed_by_name_ar
  from sales.order_status_history h
  left join lateral crm.employee_display(authz.employee_of_user(h.changed_by)) emp on true;

grant select on api.v_sellable_variants, api.v_order_status_history to authenticated;
revoke all on api.v_sellable_variants, api.v_order_status_history from anon;
