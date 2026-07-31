-- Text follow-up sequences for a personal injury intake team.
--
-- Shape of the system:
--   followup_sequences  a named schedule (quiet hours, sending number, cadence)
--   followup_steps      the individual texts, each carrying English and Spanish copy
--   followup_contacts   one row per phone number; opt-out lives here, not on the enrollment
--   followup_enrollments one contact moving through one sequence
--   followup_messages   every text in and out, for the audit trail and for idempotency
--   followup_operators  the Slack accounts allowed to start or stop follow-ups
--   followup_events     an append-only log of everything that changed an enrollment
--
-- Everything is administrator-only through RLS. The edge functions talk to these
-- tables with the service role, which bypasses RLS.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ admins

create table if not exists public.admin_users (
  email text primary key,
  created_at timestamptz not null default now(),
  constraint admin_users_email_lowercase check (email = lower(email))
);

alter table public.admin_users enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users
    where email = lower(coalesce((select auth.jwt() ->> 'email'), ''))
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

drop policy if exists "Admins can read the admin allowlist" on public.admin_users;
create policy "Admins can read the admin allowlist"
on public.admin_users for select
to authenticated
using ((select public.is_admin()));

-- --------------------------------------------------------------- sequences

create table if not exists public.followup_sequences (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  is_active boolean not null default true,
  is_default boolean not null default false,

  -- Which Quo number the texts come from. Leaving these null falls back to the
  -- QUO_FROM_NUMBER / QUO_PHONE_NUMBER_ID edge function secrets.
  quo_from_number text,
  quo_phone_number_id text,

  -- Sending window. Federal TCPA rules and the Texas Business & Commerce Code
  -- both key off the recipient's local time, so the window is evaluated in this
  -- timezone rather than the server's.
  timezone text not null default 'America/Chicago',
  quiet_hours_start smallint not null default 8,
  quiet_hours_end smallint not null default 20,
  send_days smallint[] not null default '{1,2,3,4,5,6,7}'::smallint[],

  -- Appends "Reply STOP to opt out" (or the Spanish equivalent) to the first
  -- text of the sequence.
  append_opt_out_notice boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint followup_sequences_quiet_hours_range
    check (quiet_hours_start >= 0 and quiet_hours_start < 24
       and quiet_hours_end > quiet_hours_start and quiet_hours_end <= 24),
  constraint followup_sequences_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{0,60}$')
);

-- At most one default sequence, which is what a bare `/followup start` uses.
create unique index if not exists followup_sequences_single_default_idx
  on public.followup_sequences (is_default) where is_default;

-- ------------------------------------------------------------------- steps

create table if not exists public.followup_steps (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references public.followup_sequences(id) on delete cascade,
  position int not null,
  label text,

  -- Offset from the moment the enrollment starts, not from the previous step.
  -- Editing step 2 therefore never shifts step 3.
  delay_minutes int not null default 0,

  body_en text not null,
  body_es text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint followup_steps_position_positive check (position > 0),
  constraint followup_steps_delay_nonnegative check (delay_minutes >= 0),
  constraint followup_steps_body_en_length check (char_length(body_en) between 1 and 1200),
  constraint followup_steps_body_es_length check (char_length(body_es) between 1 and 1200)
);

-- Deferred so a reorder can renumber several rows inside one transaction.
alter table public.followup_steps
  drop constraint if exists followup_steps_sequence_position_key;
alter table public.followup_steps
  add constraint followup_steps_sequence_position_key
  unique (sequence_id, position) deferrable initially deferred;

create index if not exists followup_steps_sequence_idx
  on public.followup_steps (sequence_id, position);

-- ---------------------------------------------------------------- contacts

create table if not exists public.followup_contacts (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique,
  first_name text,
  last_name text,
  language text not null default 'en',

  -- Opt-out is deliberately per phone number and not per sequence. Someone who
  -- texts STOP is done receiving texts from the firm, not just from one series.
  opted_out_at timestamptz,
  opted_out_reason text,
  opted_in_at timestamptz,

  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint followup_contacts_phone_e164_format check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint followup_contacts_language check (language in ('en', 'es'))
);

create index if not exists followup_contacts_opted_out_idx
  on public.followup_contacts (opted_out_at) where opted_out_at is not null;

-- ------------------------------------------------------------- enrollments

create table if not exists public.followup_enrollments (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references public.followup_sequences(id) on delete restrict,
  contact_id uuid not null references public.followup_contacts(id) on delete cascade,
  language text not null,
  status text not null default 'active',

  -- The person on the hook for this client. Only they (or a supervisor) can
  -- stop the series from Slack.
  assigned_slack_user_id text not null,
  assigned_slack_user_name text,
  started_by_slack_user_id text,

  slack_channel_id text,
  slack_message_ts text,
  case_reference text,

  next_position int not null default 1,
  next_run_at timestamptz,
  locked_until timestamptz,
  attempt_count int not null default 0,
  last_sent_at timestamptz,

  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text,
  ended_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint followup_enrollments_language check (language in ('en', 'es')),
  constraint followup_enrollments_status check (status in (
    'active', 'completed', 'stopped_reply', 'stopped_call',
    'stopped_manual', 'stopped_opt_out', 'failed'
  ))
);

-- One live series per phone number. Without this, two paralegals starting the
-- same client an hour apart would double-text them.
create unique index if not exists followup_enrollments_one_active_per_contact_idx
  on public.followup_enrollments (contact_id) where status = 'active';

create index if not exists followup_enrollments_due_idx
  on public.followup_enrollments (next_run_at) where status = 'active';

create index if not exists followup_enrollments_assigned_idx
  on public.followup_enrollments (assigned_slack_user_id, status);

-- ---------------------------------------------------------------- messages

create table if not exists public.followup_messages (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid references public.followup_enrollments(id) on delete set null,
  contact_id uuid not null references public.followup_contacts(id) on delete cascade,
  step_id uuid references public.followup_steps(id) on delete set null,
  direction text not null,
  language text,
  body text not null,
  status text not null default 'queued',

  -- Unique so a webhook replay cannot record the same inbound text twice.
  quo_message_id text unique,
  quo_phone_number_id text,
  from_number text,
  to_number text,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),

  constraint followup_messages_direction check (direction in ('outbound', 'inbound')),
  constraint followup_messages_status check (status in (
    'queued', 'sent', 'delivered', 'undelivered', 'failed', 'received'
  ))
);

create index if not exists followup_messages_contact_idx
  on public.followup_messages (contact_id, created_at desc);

create index if not exists followup_messages_enrollment_idx
  on public.followup_messages (enrollment_id, created_at);

-- --------------------------------------------------------------- operators

create table if not exists public.followup_operators (
  slack_user_id text primary key,
  display_name text,
  email text,
  -- Supervisors can stop a series assigned to someone else.
  is_supervisor boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint followup_operators_slack_user_id_format check (slack_user_id ~ '^[A-Z0-9]{6,}$')
);

-- ------------------------------------------------------------------ events

create table if not exists public.followup_events (
  id bigint generated always as identity primary key,
  enrollment_id uuid references public.followup_enrollments(id) on delete cascade,
  contact_id uuid references public.followup_contacts(id) on delete cascade,
  kind text not null,
  detail jsonb not null default '{}'::jsonb,
  actor text,
  created_at timestamptz not null default now()
);

create index if not exists followup_events_enrollment_idx
  on public.followup_events (enrollment_id, created_at desc);

create index if not exists followup_events_created_idx
  on public.followup_events (created_at desc);

-- ---------------------------------------------------------------- triggers

create or replace function public.followup_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  target text;
begin
  foreach target in array array[
    'followup_sequences', 'followup_steps', 'followup_contacts', 'followup_enrollments'
  ] loop
    execute format('drop trigger if exists %1$s_touch on public.%1$s', target);
    execute format(
      'create trigger %1$s_touch before update on public.%1$s
         for each row execute function public.followup_touch_updated_at()', target);
  end loop;
end;
$$;

-- Closing an enrollment from the admin UI is a plain UPDATE, so normalize the
-- bookkeeping here instead of trusting every caller to remember it.
create or replace function public.followup_close_enrollment()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'active' then
      new.ended_at := null;
      new.end_reason := null;
      new.ended_by := null;
    else
      new.ended_at := coalesce(new.ended_at, now());
      new.next_run_at := null;
      new.locked_until := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists followup_enrollments_close on public.followup_enrollments;
create trigger followup_enrollments_close
before update on public.followup_enrollments
for each row execute function public.followup_close_enrollment();

create or replace function public.followup_log_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    insert into public.followup_events (enrollment_id, contact_id, kind, detail, actor)
    values (
      new.id,
      new.contact_id,
      'status_' || new.status,
      jsonb_build_object('from', old.status, 'to', new.status, 'reason', new.end_reason),
      coalesce(new.ended_by, 'system')
    );
  end if;
  return new;
end;
$$;

drop trigger if exists followup_enrollments_log on public.followup_enrollments;
create trigger followup_enrollments_log
after update on public.followup_enrollments
for each row execute function public.followup_log_status_change();

-- --------------------------------------------------------------------- RLS

alter table public.followup_sequences enable row level security;
alter table public.followup_steps enable row level security;
alter table public.followup_contacts enable row level security;
alter table public.followup_enrollments enable row level security;
alter table public.followup_messages enable row level security;
alter table public.followup_operators enable row level security;
alter table public.followup_events enable row level security;

-- Client phone numbers and message bodies are confidential, so nothing here is
-- readable by anon. Administrators get full access; the edge functions use the
-- service role and are not subject to these policies.
do $$
declare
  target text;
begin
  foreach target in array array[
    'followup_sequences', 'followup_steps', 'followup_contacts',
    'followup_enrollments', 'followup_messages', 'followup_operators', 'followup_events'
  ] loop
    execute format('drop policy if exists "Admins read %1$s" on public.%1$s', target);
    execute format(
      'create policy "Admins read %1$s" on public.%1$s for select
         to authenticated using ((select public.is_admin()))', target);

    execute format('drop policy if exists "Admins insert %1$s" on public.%1$s', target);
    execute format(
      'create policy "Admins insert %1$s" on public.%1$s for insert
         to authenticated with check ((select public.is_admin()))', target);

    execute format('drop policy if exists "Admins update %1$s" on public.%1$s', target);
    execute format(
      'create policy "Admins update %1$s" on public.%1$s for update
         to authenticated using ((select public.is_admin()))
         with check ((select public.is_admin()))', target);

    execute format('drop policy if exists "Admins delete %1$s" on public.%1$s', target);
    execute format(
      'create policy "Admins delete %1$s" on public.%1$s for delete
         to authenticated using ((select public.is_admin()))', target);
  end loop;
end;
$$;
