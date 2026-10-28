-- Honest OS migration: reference data required in EVERY environment (incl. production).
-- Dev-only fixtures live in supabase/seed.sql. All inserts are idempotent.

-- ---------------------------------------------------------------------------
-- Geography (ISO 3166-2:EG) and initial regions (confirmed in the brief, C-04)
-- ---------------------------------------------------------------------------
insert into core.governorates (code, name_en, name_ar) values
  ('EG-C','Cairo','القاهرة'), ('EG-GZ','Giza','الجيزة'), ('EG-ALX','Alexandria','الإسكندرية'),
  ('EG-DK','Dakahlia','الدقهلية'), ('EG-SHR','Sharqia','الشرقية'), ('EG-KB','Qalyubia','القليوبية'),
  ('EG-KFS','Kafr El Sheikh','كفر الشيخ'), ('EG-GH','Gharbia','الغربية'), ('EG-MNF','Monufia','المنوفية'),
  ('EG-BH','Beheira','البحيرة'), ('EG-IS','Ismailia','الإسماعيلية'), ('EG-SUZ','Suez','السويس'),
  ('EG-PTS','Port Said','بورسعيد'), ('EG-DT','Damietta','دمياط'), ('EG-FYM','Faiyum','الفيوم'),
  ('EG-BNS','Beni Suef','بني سويف'), ('EG-MN','Minya','المنيا'), ('EG-AST','Asyut','أسيوط'),
  ('EG-SHG','Sohag','سوهاج'), ('EG-KN','Qena','قنا'), ('EG-LX','Luxor','الأقصر'),
  ('EG-ASN','Aswan','أسوان'), ('EG-BA','Red Sea','البحر الأحمر'), ('EG-WAD','New Valley','الوادي الجديد'),
  ('EG-MT','Matrouh','مطروح'), ('EG-SIN','North Sinai','شمال سيناء'), ('EG-JS','South Sinai','جنوب سيناء')
on conflict (code) do nothing;

-- Regions only; governorate coverage is configured by an admin (not assumed).
insert into core.territories (code, name_en, name_ar, level) values
  ('CAI-GIZ','Cairo & Giza','القاهرة والجيزة','region'),
  ('MANSOURA','Mansoura','المنصورة','region'),
  ('DELTA','Delta','الدلتا','region'),
  ('ALEX','Alexandria','الإسكندرية','region'),
  ('UPPER','Upper Egypt','الصعيد','region')
on conflict (code) do nothing;

insert into crm.specialties (code, name_en, name_ar) values
  ('GP','General dentistry','طب أسنان عام'), ('IMPLANTOLOGY','Implantology','زراعة الأسنان'),
  ('OMFS','Oral & maxillofacial surgery','جراحة الفم والوجه والفكين'), ('PERIO','Periodontics','علاج اللثة'),
  ('PROSTHO','Prosthodontics','التركيبات'), ('ENDO','Endodontics','علاج الجذور'),
  ('ORTHO','Orthodontics','تقويم الأسنان'), ('PEDO','Pediatric dentistry','طب أسنان الأطفال'),
  ('COSMETIC','Cosmetic dentistry','تجميل الأسنان')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Catalogue reference (C-02, C-03)
-- ---------------------------------------------------------------------------
insert into catalog.brands (code, name, country_of_origin) values
  ('BIONER','Bioner','Spain'), ('DERBY','Derby Instruments','Italy'), ('RDT','RDT GmbH','Austria')
on conflict (code) do nothing;

insert into catalog.categories (code, name_en, name_ar) values
  ('IMPLANT','Dental implants','زرعات الأسنان'), ('BUR','Dental burs','سنابل الأسنان'),
  ('INSTRUMENT','Dental instruments','أدوات الأسنان'), ('GRAFT','Bone grafts','الطعوم العظمية'),
  ('MEMBRANE','Membranes','الأغشية'), ('SUTURE','Sutures','الخيوط الجراحية'),
  ('ENDO','Endodontic products','منتجات علاج الجذور')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Permission catalogue (docs/AUTHORIZATION.md §3). Codes are module.resource.action.
-- ---------------------------------------------------------------------------
insert into authz.permissions (code, module, description, supports_limit, is_sensitive)
select v.code, split_part(v.code, '.', 1), v.descr, v.lim, v.sens
from (values
  ('admin.user.read','Read users and their status',false,false),
  ('admin.user.create','Create logins and link them to employees',false,true),
  ('admin.user.suspend','Suspend or reactivate users',false,true),
  ('admin.role.read','Read roles and role assignments',false,false),
  ('admin.role.manage','Create roles and change role permissions',false,true),
  ('admin.role.assign','Assign or revoke roles for users',false,true),
  ('admin.override.manage','Create per-user permission overrides',false,true),
  ('admin.workflow.manage','Configure approval workflows',false,true),
  ('admin.settings.manage','Change system settings',false,true),
  ('admin.integration.manage','Manage integrations and retry deliveries',false,true),
  ('core.employee.read','Read employee records',false,false),
  ('core.employee.manage','Create and update employees',false,false),
  ('core.territory.manage','Create territories and assign employees',false,false),
  ('audit.log.read','Read the data change audit log',false,true),
  ('audit.security.read','Read security events',false,true),
  ('crm.customer.read','Read customers',false,false),
  ('crm.customer.create','Create customers and leads',false,false),
  ('crm.customer.update','Update customers',false,false),
  ('crm.customer.archive','Archive customers',false,false),
  ('crm.customer.reassign','Reassign customers between employees',false,false),
  ('crm.customer.export','Export customer lists',false,true),
  ('crm.customer_balance.read','See customer balances',false,false),
  ('crm.customer_location.verify','Set or verify a customer GPS location',false,false),
  ('crm.opportunity.read','Read opportunities',false,false),
  ('crm.opportunity.manage','Create and move opportunities',false,false),
  ('crm.activity.create','Log customer activities',false,false),
  ('field.visit.create','Check in, check out and record visits',false,false),
  ('field.visit.read','Read visits',false,false),
  ('field.visit_exception.request','Request a visit verification exception',false,false),
  ('field.location.read','Read raw GPS fixes',false,true),
  ('work.task.read','Read tasks',false,false),
  ('work.task.manage','Create and complete tasks',false,false),
  ('catalog.product.read','Read products and SKUs',false,false),
  ('catalog.product.manage','Manage products and SKUs',false,false),
  ('catalog.price.read','Read selling prices',false,false),
  ('catalog.price.manage','Manage price lists and promotions',false,true),
  ('catalog.cost.read','Read purchase costs',false,true),
  ('catalog.cost.manage','Manage purchase costs',false,true),
  ('inventory.module.access','Open the inventory workspace',false,false),
  ('inventory.stock.read','Read stock levels',false,false),
  ('inventory.movement.read','Read the stock movement ledger',false,false),
  ('inventory.receipt.post','Post goods receipts',false,false),
  ('inventory.transfer.create','Create stock transfers',false,false),
  ('inventory.transfer.receive','Receive stock transfers',false,false),
  ('inventory.adjustment.post','Post stock adjustments (limit = units without approval)',true,true),
  ('inventory.writeoff.post','Post damage and expiry write-offs',false,true),
  ('sales.order.read','Read sales orders',false,false),
  ('sales.order.create','Create order drafts',false,false),
  ('sales.order.submit','Submit orders',false,false),
  ('sales.order.approve','Accept submitted orders for fulfilment',false,false),
  ('sales.order.cancel','Cancel orders',false,false),
  ('sales.order.fulfil','Reserve and fulfil orders',false,false),
  ('sales.order.export','Export orders',false,true),
  ('sales.discount.apply','Apply a manual discount (limit = max %)',true,false),
  ('sales.return.create','Create customer returns',false,false),
  ('finance.invoice.read','Read invoices',false,false),
  ('finance.invoice.issue','Issue invoices',false,true),
  ('finance.credit_note.issue','Issue credit notes',false,true),
  ('finance.payment.read','Read payments',false,false),
  ('finance.payment.record','Record payments received',false,false),
  ('finance.payment.confirm','Confirm or bounce payments',false,true),
  ('finance.payment.allocate','Allocate payments to invoices (limit = EGP)',true,true),
  ('finance.payment.reverse','Reverse payments and allocations',false,true),
  ('finance.ledger.read','Read the customer ledger',false,false),
  ('finance.collection.manage','Manage collection tasks',false,false),
  ('finance.credit_limit.change','Change customer credit limits',false,true),
  ('finance.page.aging','Open the receivables aging page',false,false),
  ('perf.kpi.read','Read KPI results',false,false),
  ('perf.kpi.manage','Manage KPI definitions',false,true),
  ('perf.target.manage','Set KPI targets',false,false),
  ('perf.commission.read','Read commission entries and statements',false,false),
  ('perf.commission_plan.read','Read commission plans and rates',false,false),
  ('perf.commission_plan.manage','Manage commission plans and rates',false,true),
  ('perf.commission.calculate','Run commission calculations',false,true),
  ('perf.commission.adjust','Create commission adjustments',false,true),
  ('wf.approval.read','Read approval requests',false,false),
  ('wf.delegation.manage','Delegate approvals',false,false),
  ('wf.decide.order_discount','Decide order discount approvals (limit = max %)',true,false),
  ('wf.decide.order_cancel','Decide order cancellations',false,false),
  ('wf.decide.inventory_adjustment','Decide inventory adjustments (limit = units)',true,true),
  ('wf.decide.customer_reassign','Decide customer reassignments',false,false),
  ('wf.decide.visit_exception','Decide visit verification exceptions',false,false),
  ('wf.decide.credit_note','Decide credit notes (limit = EGP)',true,true),
  ('wf.decide.credit_limit','Decide credit limit changes (limit = EGP)',true,true),
  ('wf.decide.return','Decide customer returns',false,false),
  ('wf.decide.commission_period','Approve commission periods',false,true),
  ('wf.decide.commission_adjust','Decide commission adjustments',false,true),
  ('wf.decide.data_export','Decide sensitive data exports',false,true),
  ('exec.page.overview','Open the executive overview',false,false),
  ('ai.assistant.use','Use the AI business assistant',false,false)
) as v(code, descr, lim, sens)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- System roles (docs/AUTHORIZATION.md §4). Editable by the owner; not deletable.
-- Job titles grant nothing — only these role assignments do.
-- ---------------------------------------------------------------------------
insert into authz.roles (code, name_en, name_ar, is_system, is_owner_role, description) values
  ('owner','Owner','المالك',true,true,'Implicit access to everything; at least one must exist'),
  ('admin','System Administrator','مسؤول النظام',true,false,'Users, roles, settings, audit; no financial authority'),
  ('sales_director','Sales Director','مدير المبيعات',true,false,null),
  ('area_manager','Area Manager','مدير منطقة',true,false,null),
  ('sales_rep','Sales Representative','مندوب مبيعات',true,false,null),
  ('inventory_manager','Inventory Manager','مدير المخزون',true,false,null),
  ('finance_officer','Finance Officer','مسؤول مالي',true,false,null),
  ('collection_officer','Collection Officer','مسؤول تحصيل',true,false,null),
  ('quality_manager','Quality Manager','مدير الجودة',true,false,null),
  ('marketing_director','Marketing Director','مدير التسويق',true,false,null),
  ('academy_manager','Academy Manager','مدير الأكاديمية',true,false,null)
on conflict (code) do nothing;

insert into authz.role_permissions (role_id, permission_code, scope, limit_value)
select r.id, v.perm, v.scope, v.lim
from (values
  -- admin: platform only; holds no money/stock/commission authority
  ('admin','admin.user.read','all',null), ('admin','admin.user.create','all',null), ('admin','admin.user.suspend','all',null),
  ('admin','admin.role.read','all',null), ('admin','admin.role.manage','all',null), ('admin','admin.role.assign','all',null),
  ('admin','admin.override.manage','all',null), ('admin','admin.workflow.manage','all',null),
  ('admin','admin.settings.manage','all',null), ('admin','admin.integration.manage','all',null),
  ('admin','core.employee.read','all',null), ('admin','core.employee.manage','all',null), ('admin','core.territory.manage','all',null),
  ('admin','audit.log.read','all',null), ('admin','audit.security.read','all',null),
  ('admin','catalog.product.read','all',null),
  -- sales director
  ('sales_director','crm.customer.read','all',null), ('sales_director','crm.customer.create','all',null),
  ('sales_director','crm.customer.update','all',null), ('sales_director','crm.customer.reassign','all',null),
  ('sales_director','crm.customer.export','all',null), ('sales_director','crm.customer_balance.read','all',null),
  ('sales_director','crm.customer_location.verify','all',null),
  ('sales_director','crm.opportunity.read','all',null), ('sales_director','crm.opportunity.manage','all',null),
  ('sales_director','crm.activity.create','all',null),
  ('sales_director','field.visit.create','own',null), ('sales_director','field.visit.read','all',null),
  ('sales_director','field.location.read','all',null),
  ('sales_director','work.task.read','all',null), ('sales_director','work.task.manage','all',null),
  ('sales_director','catalog.product.read','all',null), ('sales_director','catalog.price.read','all',null),
  ('sales_director','inventory.stock.read','all',null),
  ('sales_director','sales.order.read','all',null), ('sales_director','sales.order.create','all',null),
  ('sales_director','sales.order.submit','all',null), ('sales_director','sales.order.approve','all',null),
  ('sales_director','sales.order.cancel','all',null), ('sales_director','sales.discount.apply','all',20),
  ('sales_director','sales.return.create','all',null), ('sales_director','sales.order.export','all',null),
  ('sales_director','field.visit_exception.request','own',null), ('sales_director','finance.payment.record','team',null),
  ('sales_director','finance.invoice.read','all',null), ('sales_director','finance.payment.read','all',null),
  ('sales_director','perf.kpi.read','all',null), ('sales_director','perf.target.manage','all',null),
  ('sales_director','perf.commission.read','all',null), ('sales_director','perf.commission_plan.read','all',null),
  ('sales_director','wf.approval.read','all',null), ('sales_director','wf.decide.order_discount','all',20),
  ('sales_director','wf.decide.order_cancel','all',null), ('sales_director','wf.decide.customer_reassign','all',null),
  ('sales_director','wf.decide.visit_exception','all',null), ('sales_director','wf.decide.return','all',null),
  ('sales_director','exec.page.overview','all',null), ('sales_director','core.employee.read','all',null),
  ('sales_director','admin.user.read','team',null), ('sales_director','admin.role.assign','team',null),
  ('sales_director','ai.assistant.use','all',null),
  -- area manager
  ('area_manager','crm.customer.read','territory',null), ('area_manager','crm.customer.create','territory',null),
  ('area_manager','crm.customer.update','territory',null), ('area_manager','crm.customer.reassign','territory',null),
  ('area_manager','crm.customer_balance.read','territory',null), ('area_manager','crm.customer_location.verify','territory',null),
  ('area_manager','crm.opportunity.read','territory',null), ('area_manager','crm.opportunity.manage','territory',null),
  ('area_manager','crm.activity.create','territory',null),
  ('area_manager','field.visit.create','own',null), ('area_manager','field.visit.read','team',null),
  ('area_manager','field.location.read','team',null),
  ('area_manager','work.task.read','team',null), ('area_manager','work.task.manage','team',null),
  ('area_manager','catalog.product.read','all',null), ('area_manager','catalog.price.read','all',null),
  ('area_manager','inventory.stock.read','all',null),
  ('area_manager','sales.order.read','team',null), ('area_manager','sales.order.create','team',null),
  ('area_manager','sales.order.submit','team',null), ('area_manager','sales.order.approve','team',null),
  ('area_manager','sales.discount.apply','team',10), ('area_manager','sales.return.create','team',null),
  ('area_manager','finance.invoice.read','territory',null), ('area_manager','finance.payment.read','team',null),
  ('area_manager','finance.payment.record','team',null),
  ('area_manager','perf.kpi.read','team',null), ('area_manager','perf.commission.read','team',null),
  ('area_manager','wf.approval.read','team',null), ('area_manager','wf.decide.order_discount','team',10),
  ('area_manager','wf.decide.visit_exception','team',null), ('area_manager','wf.decide.customer_reassign','territory',null),
  ('area_manager','core.employee.read','team',null),
  -- sales representative
  ('sales_rep','crm.customer.read','own',null), ('sales_rep','crm.customer.create','own',null),
  ('sales_rep','crm.customer.update','own',null), ('sales_rep','crm.customer_balance.read','own',null),
  ('sales_rep','crm.opportunity.read','own',null), ('sales_rep','crm.opportunity.manage','own',null),
  ('sales_rep','crm.activity.create','own',null),
  ('sales_rep','field.visit.create','own',null), ('sales_rep','field.visit.read','own',null),
  ('sales_rep','field.visit_exception.request','own',null),
  ('sales_rep','work.task.read','own',null), ('sales_rep','work.task.manage','own',null),
  ('sales_rep','catalog.product.read','all',null), ('sales_rep','catalog.price.read','all',null),
  ('sales_rep','inventory.stock.read','own',null),
  ('sales_rep','sales.order.read','own',null), ('sales_rep','sales.order.create','own',null),
  ('sales_rep','sales.order.submit','own',null), ('sales_rep','sales.discount.apply','own',3),
  ('sales_rep','sales.return.create','own',null),
  ('sales_rep','finance.invoice.read','own',null), ('sales_rep','finance.payment.read','own',null),
  ('sales_rep','finance.payment.record','own',null),
  ('sales_rep','perf.kpi.read','own',null), ('sales_rep','perf.commission.read','own',null),
  -- inventory manager
  ('inventory_manager','inventory.module.access','all',null), ('inventory_manager','inventory.stock.read','all',null),
  ('inventory_manager','inventory.movement.read','all',null), ('inventory_manager','inventory.receipt.post','all',null),
  ('inventory_manager','inventory.transfer.create','all',null), ('inventory_manager','inventory.transfer.receive','all',null),
  ('inventory_manager','inventory.adjustment.post','all',5), ('inventory_manager','inventory.writeoff.post','all',null),
  ('inventory_manager','catalog.product.read','all',null), ('inventory_manager','catalog.product.manage','all',null),
  ('inventory_manager','catalog.price.read','all',null), ('inventory_manager','catalog.cost.read','all',null),
  ('inventory_manager','sales.order.read','all',null), ('inventory_manager','sales.order.fulfil','all',null),
  ('inventory_manager','wf.approval.read','all',null),
  -- finance officer
  ('finance_officer','finance.invoice.read','all',null), ('finance_officer','finance.invoice.issue','all',null),
  ('finance_officer','finance.credit_note.issue','all',null), ('finance_officer','finance.payment.read','all',null),
  ('finance_officer','finance.payment.record','all',null), ('finance_officer','finance.payment.confirm','all',null),
  ('finance_officer','finance.payment.allocate','all',null), ('finance_officer','finance.payment.reverse','all',null),
  ('finance_officer','finance.ledger.read','all',null), ('finance_officer','finance.collection.manage','all',null),
  ('finance_officer','finance.page.aging','all',null),
  ('finance_officer','crm.customer.read','all',null), ('finance_officer','crm.customer_balance.read','all',null),
  ('finance_officer','catalog.product.read','all',null), ('finance_officer','catalog.price.read','all',null),
  ('finance_officer','catalog.cost.read','all',null), ('finance_officer','sales.order.read','all',null),
  ('finance_officer','perf.commission.read','all',null), ('finance_officer','perf.commission.calculate','all',null),
  ('finance_officer','exec.page.overview','all',null), ('finance_officer','wf.approval.read','all',null),
  ('finance_officer','wf.decide.credit_note','all',null), ('finance_officer','wf.decide.credit_limit','all',null),
  -- collection officer
  ('collection_officer','crm.customer.read','all',null), ('collection_officer','crm.customer_balance.read','all',null),
  ('collection_officer','crm.activity.create','all',null), ('collection_officer','finance.invoice.read','all',null),
  ('collection_officer','finance.payment.read','own',null), ('collection_officer','finance.payment.record','own',null),
  ('collection_officer','finance.ledger.read','all',null), ('collection_officer','finance.collection.manage','all',null),
  ('collection_officer','finance.page.aging','all',null), ('collection_officer','work.task.read','own',null),
  ('collection_officer','work.task.manage','own',null), ('collection_officer','field.visit.create','own',null),
  -- quality manager (QMS permissions arrive with Phase 7)
  ('quality_manager','catalog.product.read','all',null), ('quality_manager','inventory.stock.read','all',null),
  ('quality_manager','inventory.movement.read','all',null), ('quality_manager','crm.customer.read','all',null),
  -- marketing director
  ('marketing_director','crm.customer.read','all',null), ('marketing_director','crm.customer.create','all',null),
  ('marketing_director','crm.customer.export','all',null), ('marketing_director','crm.opportunity.read','all',null),
  ('marketing_director','catalog.product.read','all',null), ('marketing_director','catalog.price.read','all',null),
  ('marketing_director','perf.kpi.read','all',null), ('marketing_director','exec.page.overview','all',null),
  -- academy manager (Academy permissions arrive with Phase 7)
  ('academy_manager','crm.customer.read','all',null), ('academy_manager','crm.customer.create','all',null),
  ('academy_manager','catalog.product.read','all',null)
) as v(role_code, perm, scope, lim)
join authz.roles r on r.code = v.role_code
on conflict (role_id, permission_code) do nothing;

-- ---------------------------------------------------------------------------
-- System settings (no secrets — CHECK enforced)
-- ---------------------------------------------------------------------------
insert into core.system_settings (key, value, description) values
  ('company.name', '"Honest®"', 'Company display name'),
  ('company.timezone', '"Africa/Cairo"', 'Business time zone (observes DST)'),
  ('company.currency', '"EGP"', 'Base currency'),
  ('sales.default_vat_pct', '14', 'Default VAT % for new products (D-12; confirm with accountant)'),
  ('field.geofence_radius_m', '150', 'Max distance from the clinic for a verified check-in'),
  ('field.max_accuracy_m', '100', 'Worse GPS accuracy than this is flagged low_accuracy'),
  ('field.location_retention_days', '365', 'Raw GPS fixes are deleted after this many days'),
  ('commission.clawback_days', '90', 'Returns within this many days after collection claw back commission (D-05)'),
  ('offline.max_queue_age_days', '7', 'Older queued device commands are flagged for review')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Order state machine (docs/ARCHITECTURE.md §5.4)
-- ---------------------------------------------------------------------------
insert into sales.order_transitions (from_status, to_status, required_permission) values
  ('draft','submitted','sales.order.submit'),
  ('draft','pending_approval','sales.order.submit'),
  ('draft','cancelled','sales.order.create'),
  ('pending_approval','approved','wf.decide.order_discount'),
  ('pending_approval','rejected','wf.decide.order_discount'),
  ('submitted','approved','sales.order.approve'),
  ('submitted','rejected','sales.order.approve'),
  ('submitted','cancelled','sales.order.cancel'),
  ('approved','reserved','sales.order.fulfil'),
  ('approved','cancelled','wf.decide.order_cancel'),
  ('reserved','partially_fulfilled','sales.order.fulfil'),
  ('reserved','fulfilled','sales.order.fulfil'),
  ('reserved','cancelled','wf.decide.order_cancel'),
  ('partially_fulfilled','fulfilled','sales.order.fulfil'),
  ('fulfilled','invoiced','finance.invoice.issue'),
  ('partially_fulfilled','invoiced','finance.invoice.issue'),
  ('invoiced','closed','finance.invoice.issue'),
  ('invoiced','returned','sales.return.create'),
  ('closed','returned','sales.return.create')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Workflow definitions with a catch-all rule and one permission-based stage.
-- Approver limits (e.g. discount %) are enforced when deciding.
-- ---------------------------------------------------------------------------
with defs(code, name, entity_type, perm) as (values
  ('sales.order.discount','Order discount above limit','sales.order','wf.decide.order_discount'),
  ('sales.order.cancel','Cancel an approved order','sales.order','wf.decide.order_cancel'),
  ('sales.return','Customer return','sales.return','wf.decide.return'),
  ('inventory.adjustment','Inventory adjustment above limit','inventory.adjustment','wf.decide.inventory_adjustment'),
  ('crm.customer.reassign','Customer reassignment','crm.customer','wf.decide.customer_reassign'),
  ('field.visit.exception','Visit verification exception','field.visit','wf.decide.visit_exception'),
  ('finance.credit_note','Credit note','finance.credit_note','wf.decide.credit_note'),
  ('finance.credit_limit','Credit limit change','crm.customer','wf.decide.credit_limit'),
  ('perf.commission_period','Commission period approval','perf.commission_period','wf.decide.commission_period'),
  ('perf.commission_adjustment','Commission adjustment','perf.commission_adjustment','wf.decide.commission_adjust'),
  ('data.export','Sensitive data export','data.export','wf.decide.data_export')
), ins_def as (
  insert into wf.workflow_definitions (code, name, entity_type)
  select code, name, entity_type from defs
  on conflict (code) do nothing
  returning id, code
), ins_rule as (
  insert into wf.workflow_rules (definition_id, priority, condition)
  select id, 100, '{}'::jsonb from ins_def
  returning id, definition_id
)
insert into wf.workflow_stages (rule_id, stage_no, approver_type, approver_permission)
select r.id, 1, 'permission', d.perm
from ins_rule r join ins_def i on i.id = r.definition_id join defs d on d.code = i.code;

-- ---------------------------------------------------------------------------
-- KPI catalogue (docs/DASHBOARDS.md §2). Metric functions arrive in Phase 5;
-- targets are set per role/employee/territory by authorised managers.
-- ---------------------------------------------------------------------------
insert into perf.kpi_definitions (code, name_en, name_ar, definition, formula, metric_key, data_source,
                                  indicator_type, period_type, unit, status) values
  ('VISITS_COMPLETED','Customer visits','الزيارات','Completed visits, one per customer per day',
   'count(distinct customer_id, local_date) where status = completed','perf.metric_visits_completed','field.visits','leading','month','count','draft'),
  ('VISITS_VERIFIED_PCT','Verified visit rate','نسبة الزيارات الموثقة','Share of completed visits with a verified or approved check-in',
   'verified ÷ completed × 100','perf.metric_visits_verified_pct','field.visits','leading','month','pct','draft'),
  ('NEW_ACCOUNTS','New customer accounts','عملاء جدد','Customers whose first invoice falls in the period',
   'count(customers with min(invoice.issue_date) in period)','perf.metric_new_accounts','finance.invoices','lagging','month','count','draft'),
  ('FOLLOW_UPS_DONE','Follow-up activities','المتابعات','Completed follow-up tasks plus linked calls, WhatsApp messages and visits',
   'count(done follow_up tasks) + count(linked activities)','perf.metric_follow_ups_done','work.tasks, crm.activities','leading','week','count','draft'),
  ('COLLECTION_RATE','Collection performance','نسبة التحصيل','Allocated collections against amounts due in the period',
   'Σ allocations on due invoices ÷ (due open AR at start + invoices due in period) × 100','perf.metric_collection_rate','finance.payment_allocations, finance.invoices','lagging','month','pct','draft'),
  ('REVENUE_ACHIEVEMENT','Sales target achievement','تحقيق المستهدف','Net invoiced revenue (excl. VAT) against target',
   'net revenue ÷ target × 100','perf.metric_net_revenue','finance.invoices, finance.credit_notes','lagging','month','pct','draft'),
  ('CONVERSION_RATE','Opportunity conversion','معدل التحويل','Won ÷ closed opportunities in the period',
   'won ÷ (won + lost) × 100','perf.metric_conversion_rate','crm.opportunities','lagging','month','pct','draft'),
  ('CRM_COMPLIANCE','CRM compliance','الالتزام بالنظام','Completed visits with outcome, notes and next step within 24 h',
   'compliant visits ÷ completed visits × 100','perf.metric_crm_compliance','field.visits, work.tasks','leading','month','pct','draft')
on conflict (code) do nothing;

-- Preliminary commission plan (C-10, D-05). Draft until confirmed; then activated.
with plan as (
  insert into perf.commission_plans (code, name, basis, effective_from, status)
  values ('STD-2026','Standard plan 2026','collected','2026-01-01','draft')
  on conflict (code) do nothing
  returning id
)
insert into perf.commission_plan_rules (plan_id, category_id, rate_pct, priority)
select plan.id, c.id, v.rate, 50
from plan
cross join (values ('IMPLANT', 5.00), ('BUR', 1.50), ('INSTRUMENT', 1.50)) as v(cat, rate)
join catalog.categories c on c.code = v.cat;
