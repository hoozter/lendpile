-- Lendpile Neon schema.
-- Auth is provided by Neon Auth in the neon_auth schema.
-- The Worker owns authorization; browser clients never receive NEON_DATABASE_URL.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.loan_data (
  user_id text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.loan_data
  ALTER COLUMN user_id TYPE text USING user_id::text;

CREATE TABLE IF NOT EXISTS public.profiles (
  user_id text PRIMARY KEY,
  email text,
  display_name text,
  recovery_email text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_users (
  user_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.legacy_user_map (
  old_user_id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  claimed_user_id text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.loan_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  owner_id text NOT NULL,
  loan_id text NOT NULL,
  loan_snapshot jsonb NOT NULL,
  permission text NOT NULL CHECK (permission IN ('view', 'edit')),
  recipient_view text NOT NULL CHECK (recipient_view IN ('borrowing', 'lending')),
  owner_display_name text,
  owner_email text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  recipient_id text,
  recipient_email text,
  recipient_display_name text,
  transfer_requested_at timestamptz,
  edit_requested_at timestamptz,
  edit_requested_by text,
  edit_request_resolved_at timestamptz,
  edit_request_outcome text CHECK (edit_request_outcome IN ('approved', 'declined')),
  recipient_seen_resolution_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.loan_shares
  ALTER COLUMN owner_id TYPE text USING owner_id::text,
  ALTER COLUMN loan_id TYPE text USING loan_id::text,
  ALTER COLUMN recipient_id TYPE text USING recipient_id::text,
  ALTER COLUMN edit_requested_by TYPE text USING edit_requested_by::text;

ALTER TABLE public.loan_shares
  ADD COLUMN IF NOT EXISTS owner_email text;

CREATE INDEX IF NOT EXISTS loan_shares_owner_idx ON public.loan_shares(owner_id);
CREATE INDEX IF NOT EXISTS loan_shares_recipient_idx ON public.loan_shares(recipient_id);
CREATE INDEX IF NOT EXISTS loan_shares_token_idx ON public.loan_shares(token);
CREATE INDEX IF NOT EXISTS legacy_user_map_email_idx ON public.legacy_user_map(lower(email));
