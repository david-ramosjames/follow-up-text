-- Text follow-up sequences for a personal injury intake team.
--
-- Slack is the system of record for who is being followed up and by whom, so
-- enrollments carry the channel and thread they were started from and every
-- notification goes back to that same thread.
--
-- The server is the only thing that talks to this database, so there is no RLS
-- here; access control lives in the session layer and in followup_operators.

create extension if not exists pgcrypto;

/* --------------------------------------------------------------- settings */

-- Everything adjustable lives here rather than in environment variables, so the
-- firm can change how the system behaves without a redeploy. Only true secrets
-- (API keys, signing secrets) stay in the environment.
create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into app_settings (key, value) values
  ('firm_name', '""'::jsonb),
  ('default_timezone', '"America/Chicago"'::jsonb),
  ('default_quo_number_id', 'null'::jsonb),
  ('slack_alert_channel', '""'::jsonb),
  ('show_full_phone_in_slack', 'false'::jsonb),
  ('send_stop_confirmation', 'true'::jsonb),
  ('dispatch_batch_size', '25'::jsonb),
  ('dispatch_interval_seconds', '60'::jsonb),
  ('max_send_attempts', '3'::jsonb),
  ('retry_delay_minutes', '15'::jsonb)
on conflict (key) do nothing;

/* ------------------------------------------------------------ Quo numbers */

-- Synced from the Quo API. A firm with several numbers picks which one each
-- sequence sends from, so personal injury texts do not go out from the number
-- the family law team answers.
create table if not exists quo_numbers (
  id text primary key,
  phone_e164 text not null,
  label text,
  is_active boolean not null default true,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

/* --------------------------------------------------------------- sequences */

create table if not exists followup_sequences (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text,
  is_active boolean not null default true,
  is_default boolean not null default false,

  quo_number_id text references quo_numbers(id) on delete set null,

  -- Federal TCPA rules and the Texas Business & Commerce Code both key off the
  -- recipient's local time, so the window is evaluated in this timezone rather
  -- than the server's.
  timezone text not null default 'America/Chicago',
  quiet_hours_start smallint not null default 9,
  quiet_hours_end smallint not null default 19,
  send_days smallint[] not null default '{1,2,3,4,5,6}'::smallint[],

  append_opt_out_notice boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint followup_sequences_quiet_hours_range
    check (quiet_hours_start >= 0 and quiet_hours_start < 24
       and quiet_hours_end > quiet_hours_start and quiet_hours_end <= 24),
  constraint followup_sequences_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{0,60}$')
);

-- At most one default, which is what a bare start command uses.
create unique index if not exists followup_sequences_single_default_idx
  on followup_sequences (is_default) where is_default;

/* ------------------------------------------------------------------- steps */

create table if not exists followup_steps (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references followup_sequences(id) on delete cascade,
  position int not null,
  label text,

  -- Offset from when the series started, not from the previous step, so editing
  -- the timing of step 2 never shifts step 3.
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

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'followup_steps_sequence_position_key'
  ) then
    -- Deferred so a reorder can renumber several rows inside one transaction.
    alter table followup_steps
      add constraint followup_steps_sequence_position_key
      unique (sequence_id, position) deferrable initially deferred;
  end if;
end;
$$;

create index if not exists followup_steps_sequence_idx
  on followup_steps (sequence_id, position);

/* ---------------------------------------------------------------- contacts */

create table if not exists followup_contacts (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique,
  first_name text,
  last_name text,
  language text not null default 'en',

  -- Opt-out is per phone number and not per sequence. Someone who texts STOP is
  -- done receiving texts from the firm, not just from one series.
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
  on followup_contacts (opted_out_at) where opted_out_at is not null;

/* ------------------------------------------------------------- enrollments */

create table if not exists followup_enrollments (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references followup_sequences(id) on delete restrict,
  contact_id uuid not null references followup_contacts(id) on delete cascade,
  language text not null,
  status text not null default 'active',

  -- The person on the hook. Only they, or a supervisor, can stop it from Slack.
  assigned_slack_user_id text not null,
  assigned_slack_user_name text,
  started_by_slack_user_id text,

  -- Where this started in Slack. slack_thread_ts is the anchor: when a series is
  -- kicked off from a message or inside a thread, every later update about that
  -- client lands in the same thread instead of scattering across the channel.
  slack_channel_id text,
  slack_thread_ts text,
  slack_message_ts text,
  source text not null default 'command',

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
  constraint followup_enrollments_source check (source in ('command', 'message_action', 'mention', 'dashboard')),
  constraint followup_enrollments_status check (status in (
    'active', 'completed', 'stopped_reply', 'stopped_call',
    'stopped_manual', 'stopped_opt_out', 'failed'
  ))
);

-- One live series per phone number. Without this, two paralegals working the
-- same lead an hour apart would double-text the client.
create unique index if not exists followup_enrollments_one_active_per_contact_idx
  on followup_enrollments (contact_id) where status = 'active';

create index if not exists followup_enrollments_due_idx
  on followup_enrollments (next_run_at) where status = 'active';

create index if not exists followup_enrollments_assigned_idx
  on followup_enrollments (assigned_slack_user_id, status);

create index if not exists followup_enrollments_started_idx
  on followup_enrollments (started_at desc);

/* ---------------------------------------------------------------- messages */

create table if not exists followup_messages (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid references followup_enrollments(id) on delete set null,
  contact_id uuid not null references followup_contacts(id) on delete cascade,
  step_id uuid references followup_steps(id) on delete set null,
  direction text not null,
  language text,
  body text not null,
  status text not null default 'queued',

  -- Unique so a replayed webhook cannot record the same inbound text twice.
  quo_message_id text unique,
  quo_number_id text,
  from_number text,
  to_number text,
  segments int,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),

  constraint followup_messages_direction check (direction in ('outbound', 'inbound')),
  constraint followup_messages_status check (status in (
    'queued', 'sent', 'delivered', 'undelivered', 'failed', 'received'
  ))
);

create index if not exists followup_messages_contact_idx
  on followup_messages (contact_id, created_at desc);

create index if not exists followup_messages_enrollment_idx
  on followup_messages (enrollment_id, created_at);

create index if not exists followup_messages_created_idx
  on followup_messages (created_at desc);

/* --------------------------------------------------------------- operators */

create table if not exists followup_operators (
  slack_user_id text primary key,
  display_name text,
  email text,
  -- Supervisors can stop a series assigned to someone else and see everyone's list.
  is_supervisor boolean not null default false,
  -- Whether this person can sign in to the dashboard at all.
  can_admin boolean not null default false,
  is_active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  constraint followup_operators_slack_user_id_format check (slack_user_id ~ '^[A-Z0-9]{6,}$')
);

/* ---------------------------------------------------------------- sessions */

create table if not exists app_sessions (
  id text primary key,
  slack_user_id text,
  display_name text,
  email text,
  is_supervisor boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists app_sessions_expiry_idx on app_sessions (expires_at);

/* ------------------------------------------------------------------ events */

create table if not exists followup_events (
  id bigint generated always as identity primary key,
  enrollment_id uuid references followup_enrollments(id) on delete cascade,
  contact_id uuid references followup_contacts(id) on delete cascade,
  kind text not null,
  detail jsonb not null default '{}'::jsonb,
  actor text,
  created_at timestamptz not null default now()
);

create index if not exists followup_events_enrollment_idx
  on followup_events (enrollment_id, created_at desc);

create index if not exists followup_events_created_idx
  on followup_events (created_at desc);

/* ---------------------------------------------------------------- triggers */

create or replace function followup_touch_updated_at()
returns trigger language plpgsql as $$
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
    execute format('drop trigger if exists %1$s_touch on %1$s', target);
    execute format(
      'create trigger %1$s_touch before update on %1$s
         for each row execute function followup_touch_updated_at()', target);
  end loop;
end;
$$;

-- Closing a series from the dashboard is a plain UPDATE, so normalize the
-- bookkeeping here rather than trusting every caller to remember it.
create or replace function followup_close_enrollment()
returns trigger language plpgsql as $$
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

drop trigger if exists followup_enrollments_close on followup_enrollments;
create trigger followup_enrollments_close
before update on followup_enrollments
for each row execute function followup_close_enrollment();

create or replace function followup_log_status_change()
returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status then
    insert into followup_events (enrollment_id, contact_id, kind, detail, actor)
    values (
      new.id, new.contact_id, 'status_' || new.status,
      jsonb_build_object('from', old.status, 'to', new.status, 'reason', new.end_reason),
      coalesce(new.ended_by, 'system')
    );
  end if;
  return new;
end;
$$;

drop trigger if exists followup_enrollments_log on followup_enrollments;
create trigger followup_enrollments_log
after update on followup_enrollments
for each row execute function followup_log_status_change();
