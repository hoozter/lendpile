-- =============================================================================
-- Lendpile: Check database schema (run in Supabase SQL Editor)
-- =============================================================================
-- Run this to see what your database has. One result set: kind, name, detail.
-- Compare with the "Expected" list in the comment block at the end of this file.
-- This script only reads; it does not change anything.
-- =============================================================================

select * from (
  select 1 as ord, 'TABLE' as kind, table_schema || '.' || table_name as name, '' as detail
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'

  union all

  select 2, 'COLUMN', 'loan_data.' || column_name, data_type
  from information_schema.columns
  where table_schema = 'public' and table_name = 'loan_data'

  union all

  select 3, 'COLUMN', 'loan_shares.' || column_name, data_type
  from information_schema.columns
  where table_schema = 'public' and table_name = 'loan_shares'

  union all

  select 4, 'POLICY', 'loan_data.' || policyname, cmd::text
  from pg_policies where schemaname = 'public' and tablename = 'loan_data'

  union all

  select 5, 'POLICY', 'loan_shares.' || policyname, cmd::text
  from pg_policies where schemaname = 'public' and tablename = 'loan_shares'

  union all

  select 6, 'FUNCTION', routine_name, routine_type
  from information_schema.routines
  where routine_schema = 'public'

  union all

  select 7, 'TRIGGER', 'loan_data.' || trigger_name, event_manipulation
  from information_schema.triggers
  where event_object_schema = 'public' and event_object_table = 'loan_data'
) t
order by ord, name;

-- =============================================================================
-- EXPECTED (from docs/supabase-schema.sql)
-- =============================================================================
--
-- TABLES: public.loan_data, public.loan_shares
--
-- loan_data COLUMNS: user_id (uuid), data (jsonb), updated_at (timestamptz)
--
-- loan_shares COLUMNS: id, token, owner_id, loan_id, loan_snapshot, permission,
--   recipient_view, owner_display_name, expires_at, used_at, recipient_id,
--   transfer_requested_at, created_at
--
-- loan_data POLICIES (4): Users can read/insert/update/delete own loan_data
--
-- loan_shares POLICIES (5): Recipients can select shares offered to them,
--   Users can insert/select/update/delete own loan_shares
--
-- FUNCTIONS (8): accept_transfer, cancel_transfer_request, decline_transfer,
--   get_share_by_token, redeem_share, request_transfer_to_recipient,
--   set_loan_data_updated_at, update_shared_loan
--
-- TRIGGERS (1): loan_data.loan_data_updated_at
--
-- If something is missing, run the full docs/supabase-schema.sql again.
-- =============================================================================
