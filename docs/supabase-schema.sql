-- Lendpile: Supabase schema for auth and loan_data sync
-- Run in Supabase Dashboard → SQL Editor → New query, then Run.
-- Safe to run the ENTIRE file multiple times: tables use IF NOT EXISTS,
-- functions use OR REPLACE, and policies/triggers use DROP IF EXISTS first.
-- No data is deleted; existing rows stay unchanged.
--
-- Email confirmation redirect: In Dashboard → Authentication → URL Configuration,
-- set Site URL to the exact app page URL, including the file name, for example:
--   http://localhost:8080/app.html  (or https://lendpile.com/app.html in production)
-- (not http://localhost:8080/ or you will get a directory listing and the app
-- will not load, so the session from the confirmation link cannot be recovered.)

-- Table: one row per user, stores serialized loan data as JSON
create table if not exists public.loan_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- RLS: users can only read/write their own row
alter table public.loan_data enable row level security;

drop policy if exists "Users can read own loan_data" on public.loan_data;
create policy "Users can read own loan_data"
  on public.loan_data for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own loan_data" on public.loan_data;
create policy "Users can insert own loan_data"
  on public.loan_data for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own loan_data" on public.loan_data;
create policy "Users can update own loan_data"
  on public.loan_data for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own loan_data" on public.loan_data;
create policy "Users can delete own loan_data"
  on public.loan_data for delete
  using (auth.uid() = user_id);

-- Optional: keep updated_at in sync on update (app does not send it)
create or replace function public.set_loan_data_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists loan_data_updated_at on public.loan_data;
create trigger loan_data_updated_at
  before update on public.loan_data
  for each row execute function public.set_loan_data_updated_at();

-- =============================================================================
-- Loan sharing: time-limited, one-time-use links
-- =============================================================================

create table if not exists public.loan_shares (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  owner_id uuid not null references auth.users(id) on delete cascade,
  loan_id uuid not null,
  loan_snapshot jsonb not null,
  permission text not null check (permission in ('view', 'edit')),
  recipient_view text not null check (recipient_view in ('borrowing', 'lending')),
  owner_display_name text,
  expires_at timestamptz not null,
  used_at timestamptz,
  recipient_id uuid references auth.users(id) on delete set null,  -- recipient delete does not affect owner's loan_data
  recipient_email text,  -- set when share is redeemed, so owner can see who accepted (used_at is only set on redeem, not on preview)
  transfer_requested_at timestamptz,  -- when set, owner has asked to give loan to recipient; recipient must accept or decline
  created_at timestamptz not null default now()
);

alter table public.loan_shares enable row level security;

-- Backfill for existing DBs that already had loan_shares without this column:
do $$ begin alter table public.loan_shares add column if not exists transfer_requested_at timestamptz; exception when others then null; end $$;

-- Edit access request (recipient requests; owner approves/declines; recipient sees resolution banner on next load).
-- Optional later: email notifications (to requester when approved/declined, to owner when request received) via Edge Functions.
do $$ begin alter table public.loan_shares add column if not exists edit_requested_at timestamptz; exception when others then null; end $$;
do $$ begin alter table public.loan_shares add column if not exists edit_requested_by uuid references auth.users(id) on delete set null; exception when others then null; end $$;
do $$ begin alter table public.loan_shares add column if not exists edit_request_resolved_at timestamptz; exception when others then null; end $$;
do $$ begin alter table public.loan_shares add column if not exists edit_request_outcome text check (edit_request_outcome in ('approved', 'declined')); exception when others then null; end $$;
do $$ begin alter table public.loan_shares add column if not exists recipient_seen_resolution_at timestamptz; exception when others then null; end $$;

drop policy if exists "Recipients can select shares offered to them" on public.loan_shares;
create policy "Recipients can select shares offered to them"
  on public.loan_shares for select
  using (auth.uid() = recipient_id);

drop policy if exists "Users can insert own loan_shares" on public.loan_shares;
create policy "Users can insert own loan_shares"
  on public.loan_shares for insert
  with check (auth.uid() = owner_id);

drop policy if exists "Users can select own loan_shares" on public.loan_shares;
create policy "Users can select own loan_shares"
  on public.loan_shares for select
  using (auth.uid() = owner_id);

drop policy if exists "Users can update own loan_shares" on public.loan_shares;
create policy "Users can update own loan_shares"
  on public.loan_shares for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "Users can delete own loan_shares" on public.loan_shares;
create policy "Users can delete own loan_shares"
  on public.loan_shares for delete
  using (auth.uid() = owner_id);

-- Recipient can revoke (delete) a share they received; same effect as owner revoking.
drop policy if exists "Recipients can delete shares they received" on public.loan_shares;
create policy "Recipients can delete shares they received"
  on public.loan_shares for delete
  using (auth.uid() = recipient_id);

-- Backfill: add recipient_email if missing (set when share is redeemed).
do $$ begin alter table public.loan_shares add column if not exists recipient_email text; exception when others then null; end $$;

-- Return share by token if valid (not expired; unused or already redeemed by this user).
create or replace function public.get_share_by_token(share_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  row record;
begin
  select id, owner_id, loan_id, loan_snapshot, permission, recipient_view, owner_display_name, expires_at, used_at, recipient_id,
    edit_requested_at, edit_requested_by, edit_request_resolved_at, edit_request_outcome, recipient_seen_resolution_at
  into row
  from public.loan_shares
  where token = share_token;
  if not found then
    return null;
  end if;
  if row.expires_at <= now() then
    return null;
  end if;
  if row.used_at is not null and row.recipient_id is distinct from auth.uid() then
    return null;
  end if;
  return json_build_object(
    'id', row.id,
    'owner_id', row.owner_id,
    'loan_id', row.loan_id,
    'loan_snapshot', row.loan_snapshot,
    'permission', row.permission,
    'recipient_view', row.recipient_view,
    'owner_display_name', row.owner_display_name,
    'expires_at', row.expires_at,
    'used_at', row.used_at,
    'recipient_id', row.recipient_id,
    'edit_requested_at', row.edit_requested_at,
    'edit_requested_by', row.edit_requested_by,
    'edit_request_resolved_at', row.edit_request_resolved_at,
    'edit_request_outcome', row.edit_request_outcome,
    'recipient_seen_resolution_at', row.recipient_seen_resolution_at
  );
end;
$$;

-- Redeem share: only when a signed-in user explicitly accepts. Sets recipient_id, recipient_email, used_at.
-- The link stays valid (get_share_preview returns data) until either it is redeemed here or expires_at passes.
create or replace function public.redeem_share(share_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  row record;
  uid uuid;
  rec_email text;
begin
  uid := auth.uid();
  if uid is null then
    return null;
  end if;
  select * into row from public.loan_shares where token = share_token;
  if not found or row.expires_at <= now() then
    return null;
  end if;
  if row.used_at is not null and row.recipient_id is distinct from uid then
    return null;
  end if;
  if row.used_at is null then
    select email into rec_email from auth.users where id = uid limit 1;
    update public.loan_shares
    set used_at = now(), recipient_id = uid, recipient_email = rec_email
    where id = row.id;
  end if;
  return public.get_share_by_token(share_token);
end;
$$;

-- Share landing preview: public, no auth. Read-only; does not set used_at.
-- Link remains valid until someone signs in and redeems (redeem_share) or until expires_at.
create or replace function public.get_share_preview(share_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  row record;
begin
  select owner_display_name, loan_snapshot into row
  from public.loan_shares
  where token = share_token and expires_at > now();
  if not found then
    return null;
  end if;
  return json_build_object(
    'owner_display_name', row.owner_display_name,
    'loan_name', row.loan_snapshot->>'name'
  );
end;
$$;

-- Update owner's loan when recipient (with edit permission) saves.
create or replace function public.update_shared_loan(share_token text, loan_json jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  new_data jsonb;
begin
  select * into s from public.loan_shares
  where token = share_token and permission = 'edit' and recipient_id = auth.uid() and used_at is not null and expires_at > now();
  if not found then
    return false;
  end if;
  select jsonb_agg(
    case when (elem->>'id') = (s.loan_id::text) then loan_json else elem end
  ) into new_data
  from public.loan_data ld, jsonb_array_elements(ld.data) as elem
  where ld.user_id = s.owner_id;
  if new_data is null then
    return false;
  end if;
  update public.loan_data set data = new_data, updated_at = now() where user_id = s.owner_id;
  return true;
end;
$$;

-- Owner requests to transfer the loan to the recipient. Recipient must accept or decline.
create or replace function public.request_transfer_to_recipient(share_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.loan_shares
  set transfer_requested_at = now()
  where id = share_id and owner_id = auth.uid() and recipient_id is not null and used_at is not null and transfer_requested_at is null;
  return found;
end;
$$;

-- Recipient accepts: loan moves to their account, share is deleted.
create or replace function public.accept_transfer(share_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  loan_json jsonb;
  new_owner_data jsonb;
begin
  select * into s from public.loan_shares
  where id = share_id and recipient_id = auth.uid() and transfer_requested_at is not null;
  if not found then
    return false;
  end if;
  select elem into loan_json
  from public.loan_data ld, jsonb_array_elements(ld.data) as elem
  where ld.user_id = s.owner_id and (elem->>'id') = (s.loan_id::text)
  limit 1;
  if loan_json is null then
    return false;
  end if;
  select jsonb_agg(e) into new_owner_data
  from public.loan_data ld, jsonb_array_elements(ld.data) as e
  where ld.user_id = s.owner_id and (e->>'id') <> (s.loan_id::text);
  update public.loan_data set data = coalesce(new_owner_data, '[]'::jsonb), updated_at = now() where user_id = s.owner_id;
  insert into public.loan_data (user_id, data)
  values (s.recipient_id, jsonb_build_array(loan_json))
  on conflict (user_id) do update
  set data = public.loan_data.data || jsonb_build_array(loan_json), updated_at = now();
  delete from public.loan_shares where id = share_id;
  return true;
end;
$$;

-- Recipient declines: transfer request is cleared; loan stays with owner.
create or replace function public.decline_transfer(share_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.loan_shares
  set transfer_requested_at = null
  where id = share_id and recipient_id = auth.uid() and transfer_requested_at is not null;
  return found;
end;
$$;

-- Owner cancels a pending transfer request.
create or replace function public.cancel_transfer_request(share_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.loan_shares
  set transfer_requested_at = null
  where id = share_id and owner_id = auth.uid() and transfer_requested_at is not null;
  return found;
end;
$$;

-- Recipient requests edit access (view-only share). Owner can approve or decline later.
create or replace function public.request_edit_access(share_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.loan_shares
  set edit_requested_at = now(), edit_requested_by = auth.uid()
  where id = share_id and recipient_id = auth.uid() and permission = 'view'
    and expires_at > now() and used_at is not null
    and edit_requested_at is null and edit_request_resolved_at is null;
  return found;
end;
$$;

-- Owner approves edit request: set permission to edit, clear request, set resolution for recipient banner.
create or replace function public.approve_edit_request(share_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.loan_shares
  set permission = 'edit',
      edit_requested_at = null, edit_requested_by = null,
      edit_request_resolved_at = now(), edit_request_outcome = 'approved'
  where id = share_id and owner_id = auth.uid() and edit_requested_at is not null;
  return found;
end;
$$;

-- Owner declines edit request. Recipient sees resolution banner.
create or replace function public.decline_edit_request(share_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.loan_shares
  set edit_requested_at = null, edit_requested_by = null,
      edit_request_resolved_at = now(), edit_request_outcome = 'declined'
  where id = share_id and owner_id = auth.uid() and edit_requested_at is not null;
  return found;
end;
$$;

-- Recipient marks resolution as seen (so we do not show the banner again).
create or replace function public.mark_edit_resolution_seen(share_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.loan_shares
  set recipient_seen_resolution_at = now()
  where id = share_id and recipient_id = auth.uid() and edit_request_resolved_at is not null and recipient_seen_resolution_at is null;
  return found;
end;
$$;
