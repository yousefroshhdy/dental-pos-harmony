-- Drop four duplicate indexes (Supabase performance advisor, duplicate_index). The owner approved
-- this in writing on 2026-10-31 (CLAUDE.md rule 9: dropping an index deletes no data).
-- 20261103000700 created a second copy of indexes that the returns and commissions migrations had
-- already created under another name. The originals stay, so every foreign key is still covered
-- (suite 40), and suite 40 now fails on any new duplicate.
drop index if exists perf.idx_commission_plan_rules_plan_id;  -- same as perf.idx_commission_rules_plan
drop index if exists sales.idx_return_items_return_id;        -- same as sales.idx_return_items_return
drop index if exists sales.idx_returns_customer_id;           -- same as sales.idx_returns_customer
drop index if exists sales.idx_returns_order_id;              -- same as sales.idx_returns_order
