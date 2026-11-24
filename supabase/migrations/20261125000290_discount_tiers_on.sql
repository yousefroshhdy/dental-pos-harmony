-- Owner decision B (2026-11-24) goes live: manual discounts use the tiers (rep 0 %, sales manager
-- up to 25 %, owner above) instead of each role's old permission limit. 20261125000200 added the
-- setting with "per_role" as its default so existing behaviour did not change silently; this
-- migration sets the live value. The owner can switch back in Admin -> Settings.
-- supabase/seed.sql (local and CI tests only) pins "per_role" for the fixture's role limits,
-- which the older suites assert; suite 56 switches to "tiered" itself.
insert into core.system_settings (key, value, description)
values ('sales.discount.limit_mode', '"tiered"', 'Decision B discount tiers (owner decision 2026-11-24)')
on conflict (key) do update set value = excluded.value, updated_at = now();
