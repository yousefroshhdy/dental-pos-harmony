-- Covering indexes for the two import.batches foreign keys the Supabase performance advisor
-- flagged (unindexed_foreign_keys). Suite 40's FK-coverage check now includes the import schema.
create index if not exists idx_batches_committed_by on import.batches (committed_by);
create index if not exists idx_batches_discarded_by on import.batches (discarded_by);
