-- Honest OS migration: integration of the modules built in parallel on 2026-11-03.
--
-- 1. Covering indexes for the foreign keys those modules added (suite 40's guard),
--    plus the allocation-date index the commission engine scans by.
-- 2. Admin settings whitelist (core.setting_definitions) rows for the settings other
--    modules seeded, so suite 41's "every stored setting has a definition" holds and
--    the settings screen can show them. Non-destructive: inserts only.

-- 1. Indexes ------------------------------------------------------------------
create index if not exists idx_commission_entries_customer_id on perf.commission_entries (customer_id);
create index if not exists idx_commission_entries_invoice_id on perf.commission_entries (invoice_id);
create index if not exists idx_delegations_created_by on wf.delegations (created_by);
create index if not exists idx_delegations_revoked_by on wf.delegations (revoked_by);
create index if not exists idx_invoice_write_offs_posted_by on finance.invoice_write_offs (posted_by);
create index if not exists idx_invoice_write_offs_requested_by on finance.invoice_write_offs (requested_by);
create index if not exists idx_order_draft_saves_saved_by on sales.order_draft_saves (saved_by);
create index if not exists idx_returns_approval_request_id on sales.returns (approval_request_id);
create index if not exists idx_returns_credited_by on sales.returns (credited_by);
create index if not exists idx_returns_received_by on sales.returns (received_by);
create index if not exists idx_row_image_masks_unmask_permission on audit.row_image_masks (unmask_permission);
create index if not exists idx_visit_frequencies_updated_by on field.visit_frequencies (updated_by);
create index if not exists idx_visit_plan_batches_employee_id on field.visit_plan_batches (employee_id);
create index if not exists idx_visit_plan_batches_requested_by on field.visit_plan_batches (requested_by);
create index if not exists idx_workflow_stages_escalate_to_user_id on wf.workflow_stages (escalate_to_user_id);
create index if not exists idx_payment_allocations_allocated_at on finance.payment_allocations (allocated_at);

-- 2. Setting definitions --------------------------------------------------------
insert into core.setting_definitions
  (key, group_code, value_type, min_value, max_value, allowed_values, default_value, unit, owner_only, is_editable,
   label_en, label_ar, description_en, description_ar, sort_order) values
  ('company.legal_name_en', 'company', 'text', null, null, null, '"Honest (synthetic placeholder)"', null, false, true,
   'Legal name (English)', 'الاسم القانوني (إنجليزي)', 'Printed on invoices and receipts.', 'يُطبع على الفواتير والإيصالات.', 20),
  ('company.legal_name_ar', 'company', 'text', null, null, null, '"هونست (بيانات تجريبية)"', null, false, true,
   'Legal name (Arabic)', 'الاسم القانوني (عربي)', 'Printed on invoices and receipts.', 'يُطبع على الفواتير والإيصالات.', 21),
  ('company.address_en', 'company', 'text', null, null, null, '""', null, false, true,
   'Address (English)', 'العنوان (إنجليزي)', 'Printed on invoices and receipts.', 'يُطبع على الفواتير والإيصالات.', 22),
  ('company.address_ar', 'company', 'text', null, null, null, '""', null, false, true,
   'Address (Arabic)', 'العنوان (عربي)', 'Printed on invoices and receipts.', 'يُطبع على الفواتير والإيصالات.', 23),
  ('company.tax_registration_no', 'company', 'text', null, null, null, '""', null, true, true,
   'Tax registration number', 'رقم التسجيل الضريبي', 'Printed on invoices. Owner only.', 'يُطبع على الفواتير. للمالك فقط.', 24),
  ('company.commercial_register_no', 'company', 'text', null, null, null, '""', null, true, true,
   'Commercial register number', 'رقم السجل التجاري', 'Printed on invoices. Owner only.', 'يُطبع على الفواتير. للمالك فقط.', 25),
  ('company.phone', 'company', 'text', null, null, null, '""', null, false, true,
   'Company phone', 'هاتف الشركة', 'Printed on invoices and receipts (E.164, e.g. +20…).', 'يُطبع على الفواتير والإيصالات (بصيغة +20…).', 26),
  ('company.logo_url', 'company', 'text', null, null, null, '""', null, false, true,
   'Logo URL', 'رابط الشعار', 'An https image URL shown on printed documents. Empty = no logo.', 'رابط صورة https يظهر على المستندات المطبوعة. فارغ = بدون شعار.', 27),
  ('commission.default_plan_code', 'commission', 'text', null, null, null, '"STD-2026"', null, true, true,
   'Default commission plan', 'خطة العمولة الافتراضية', 'Plan code used when an employee has no plan assigned.', 'كود الخطة المستخدمة إذا لم تُحدَّد خطة للموظف.', 10),
  ('planning.daily_visit_cap', 'field', 'integer', 1, 30, null, '8', 'visits', false, true,
   'Planned visits per day (cap)', 'الحد الأقصى للزيارات المخططة يوميًا', 'The plan generator never schedules more visits than this on one day.', 'مولّد الخطة لا يجدول أكثر من هذا العدد في اليوم.', 60),
  ('planning.default_visit_class', 'field', 'enum', null, null, array['A','B','C'], '"C"', null, false, true,
   'Default visit class', 'فئة الزيارة الافتراضية', 'Class used for customers without one (A weekly, B every 2 weeks, C monthly).', 'الفئة المستخدمة للعملاء بدون فئة (A أسبوعي، B كل أسبوعين، C شهري).', 61),
  ('planning.visit_interval_days', 'field', 'text', null, null, null, '{"A":7,"B":14,"C":30}', 'days', false, false,
   'Visit interval per class', 'الفاصل بين الزيارات لكل فئة', 'Days between visits for classes A, B and C. Changed by migration only.', 'عدد الأيام بين الزيارات للفئات A وB وC. يتغيّر عبر التحديثات فقط.', 62),
  ('planning.work_days', 'field', 'enum_array', null, null, array['sat','sun','mon','tue','wed','thu','fri'], '["sun","mon","tue","wed","thu"]', null, false, true,
   'Working days for visit plans', 'أيام العمل لخطط الزيارات', 'Days the plan generator may use.', 'الأيام التي يستخدمها مولّد الخطة.', 63),
  ('security.mfa_enforced', 'security', 'boolean', null, null, null, 'false', null, true, true,
   'Require MFA for sensitive actions', 'طلب التحقق بخطوتين للعمليات الحساسة', 'When on, permissions marked "requires MFA" need a session verified with an authenticator app. Roll out only after users have enrolled.', 'عند التفعيل، تحتاج الصلاحيات الحساسة إلى جلسة موثّقة بتطبيق المصادقة. فعّله فقط بعد تسجيل المستخدمين.', 10),
  ('wf.delegation.max_days', 'workflow', 'integer', 1, 365, null, '90', 'days', false, true,
   'Longest delegation', 'أطول مدة تفويض', 'Maximum length of an out-of-office delegation.', 'أقصى مدة لتفويض الموافقات أثناء الغياب.', 10),
  ('wf.escalation.max_levels', 'workflow', 'integer', 1, 10, null, '3', 'levels', false, true,
   'Escalation levels', 'مستويات التصعيد', 'How many times a waiting approval can move up before it reaches the owners.', 'عدد مرات تصعيد طلب الموافقة قبل وصوله للمالك.', 11)
on conflict (key) do nothing;
