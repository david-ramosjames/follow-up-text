-- Four things the first cut of lead intake got wrong or left out.
--
-- 1. There was no way to see what the router made of a post without letting it
--    text somebody. Observations are now recorded whatever mode it is in, so
--    the thing can be watched for a week before it is trusted.
-- 2. {{case_reference}} is a case *number*, typed by a person starting a series
--    by hand. What the copy actually wants is the case *type* — "car accident",
--    "slip and fall" — which the classifier was already reading and discarding.
-- 3. Every active sequence was offered to the router, including the manual
--    no-contact one. A sequence now has to opt in.
-- 4. The lead channel carries plenty besides form fills. Recording every
--    decision makes it possible to see what is being picked up.

-- A sequence has to opt in to being chosen automatically. Default false, so
-- every sequence that exists today — including the manually-triggered New lead
-- follow-up — stays out of the router until somebody says otherwise.
alter table followup_sequences
  add column if not exists auto_routable boolean not null default false;

comment on column followup_sequences.auto_routable is
  'Offered to the lead router as a track. Off means the sequence can only be started by a person.';

-- The kind of case, as opposed to case_reference, which is a case number.
alter table followup_enrollments
  add column if not exists case_type text;

alter table followup_contacts
  add column if not exists case_type text;

comment on column followup_enrollments.case_type is
  'What happened to them — "rear-ended by a truck". Merged into copy as {{case_type}}. '
  'Not to be confused with case_reference, which is the firm''s own case number.';

-- Every post the router looked at and what it concluded, whether or not it
-- acted. This is the record that makes the thing reviewable: in preview mode it
-- is the only output, and in live mode it is how a wrong route is understood
-- after the fact.
create table if not exists lead_observations (
  id uuid primary key default gen_random_uuid(),
  slack_channel_id text,
  slack_ts text,
  slack_permalink text,
  sender_name text,
  sender_app_id text,

  post_text text not null,
  mode text not null,

  -- What was read without a model.
  phone_e164 text,
  email text,

  -- What the model concluded, and what it cost to find out.
  is_lead boolean,
  sequence_slug text,
  sequence_name text,
  language text,
  first_name text,
  last_name text,
  case_type text,
  lead_source text,
  confidence text,
  reasoning text,
  classifier_error text,

  -- Exactly the text this lead would have received, merge fields filled in.
  preview_body text,
  preview_segments int,

  outcome text not null,
  outcome_detail text,
  enrollment_id uuid references followup_enrollments(id) on delete set null,

  created_at timestamptz not null default now(),

  constraint lead_observations_mode check (mode in ('preview', 'live')),
  constraint lead_observations_outcome check (outcome in (
    'started', 'preview_only', 'not_a_lead', 'no_phone', 'ignored_sender',
    'enroll_failed', 'no_owner', 'classifier_failed'))
);

-- One row per Slack message, so a redelivered event does not double-record.
create unique index if not exists lead_observations_message_idx
  on lead_observations (slack_channel_id, slack_ts)
  where slack_ts is not null;

create index if not exists lead_observations_recent_idx
  on lead_observations (created_at desc);

-- Carry the case type onto the enrollment and the contact, the same way the
-- name is carried, so it survives into every text of the series.
create or replace function followup_enroll(payload jsonb)
returns jsonb language plpgsql as $$
declare
  seq followup_sequences;
  contact followup_contacts;
  step followup_steps;
  enrollment followup_enrollments;
  existing followup_enrollments;
  v_phone text;
  v_language text;
  v_assignee text;
  v_source text;
  v_step_count int;
begin
  v_phone := followup_normalize_phone(payload ->> 'phone');
  if v_phone is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_phone');
  end if;

  v_assignee := nullif(btrim(coalesce(payload ->> 'assigned_slack_user_id', '')), '');
  if v_assignee is null then
    return jsonb_build_object('ok', false, 'reason', 'missing_assignee');
  end if;

  v_source := coalesce(nullif(payload ->> 'source', ''), 'command');
  if v_source not in ('command', 'message_action', 'mention', 'dashboard', 'lead') then
    v_source := 'command';
  end if;

  if nullif(btrim(coalesce(payload ->> 'sequence_slug', '')), '') is not null then
    select * into seq from followup_sequences where slug = lower(btrim(payload ->> 'sequence_slug'));
  else
    select * into seq from followup_sequences where is_default order by created_at limit 1;
  end if;

  if seq.id is null then
    return jsonb_build_object('ok', false, 'reason', 'sequence_not_found');
  end if;
  if not seq.is_active then
    return jsonb_build_object('ok', false, 'reason', 'sequence_inactive',
                              'sequence', jsonb_build_object('slug', seq.slug, 'name', seq.name));
  end if;

  select count(*) into v_step_count from followup_steps where sequence_id = seq.id and is_active;
  if v_step_count = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_steps',
                              'sequence', jsonb_build_object('slug', seq.slug, 'name', seq.name));
  end if;

  insert into followup_contacts as target (phone_e164, first_name, last_name, language, case_type)
  values (
    v_phone,
    nullif(btrim(coalesce(payload ->> 'first_name', '')), ''),
    nullif(btrim(coalesce(payload ->> 'last_name', '')), ''),
    coalesce(nullif(lower(btrim(coalesce(payload ->> 'language', ''))), ''), 'en'),
    nullif(btrim(coalesce(payload ->> 'case_type', '')), '')
  )
  on conflict (phone_e164) do update
    set first_name = coalesce(nullif(btrim(coalesce(excluded.first_name, '')), ''), target.first_name),
        last_name = coalesce(nullif(btrim(coalesce(excluded.last_name, '')), ''), target.last_name),
        case_type = coalesce(nullif(btrim(coalesce(excluded.case_type, '')), ''), target.case_type),
        language = case
          when nullif(btrim(coalesce(payload ->> 'language', '')), '') is not null
          then excluded.language else target.language end
  returning * into contact;

  if contact.opted_out_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'opted_out', 'phone', contact.phone_e164);
  end if;

  select * into existing from followup_enrollments
    where contact_id = contact.id and status = 'active' limit 1;
  if existing.id is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_active',
                              'enrollment_id', existing.id,
                              'assigned_slack_user_id', existing.assigned_slack_user_id,
                              'slack_channel_id', existing.slack_channel_id,
                              'slack_thread_ts', existing.slack_thread_ts);
  end if;

  v_language := coalesce(nullif(lower(btrim(coalesce(payload ->> 'language', ''))), ''), contact.language, 'en');
  if v_language not in ('en', 'es') then v_language := 'en'; end if;

  insert into followup_enrollments (
    sequence_id, contact_id, language, assigned_slack_user_id, assigned_slack_user_name,
    started_by_slack_user_id, slack_channel_id, slack_thread_ts, source, case_reference,
    case_type, lead_source, lead_detail, next_position
  ) values (
    seq.id, contact.id, v_language, v_assignee,
    nullif(btrim(coalesce(payload ->> 'assigned_slack_user_name', '')), ''),
    nullif(btrim(coalesce(payload ->> 'started_by_slack_user_id', '')), ''),
    nullif(btrim(coalesce(payload ->> 'slack_channel_id', '')), ''),
    nullif(btrim(coalesce(payload ->> 'slack_thread_ts', '')), ''),
    v_source,
    nullif(btrim(coalesce(payload ->> 'case_reference', '')), ''),
    coalesce(nullif(btrim(coalesce(payload ->> 'case_type', '')), ''), contact.case_type),
    nullif(btrim(coalesce(payload ->> 'lead_source', '')), ''),
    payload -> 'lead_detail',
    1
  ) returning * into enrollment;

  select * into step from followup_steps where sequence_id = seq.id and is_active order by position limit 1;

  update followup_enrollments
  set next_position = step.position,
      next_run_at = followup_step_due_at(enrollment, seq, step)
  where id = enrollment.id
  returning * into enrollment;

  insert into followup_events (enrollment_id, contact_id, kind, detail, actor)
  values (enrollment.id, contact.id, 'enrolled',
          jsonb_build_object('sequence', seq.slug, 'language', v_language, 'steps', v_step_count,
                             'source', v_source, 'first_send_at', enrollment.next_run_at),
          coalesce(payload ->> 'started_by_slack_user_id', v_assignee));

  return jsonb_build_object(
    'ok', true,
    'enrollment_id', enrollment.id,
    'contact_id', contact.id,
    'phone', contact.phone_e164,
    'first_name', contact.first_name,
    'language', v_language,
    'step_count', v_step_count,
    'next_run_at', enrollment.next_run_at,
    'assigned_slack_user_id', enrollment.assigned_slack_user_id,
    'case_reference', enrollment.case_reference,
    'case_type', enrollment.case_type,
    'slack_channel_id', enrollment.slack_channel_id,
    'slack_thread_ts', enrollment.slack_thread_ts,
    'sequence', jsonb_build_object('slug', seq.slug, 'name', seq.name, 'timezone', seq.timezone)
  );
end;
$$;

-- {{case_type}} has to reach the dispatcher for the merge to work.
create or replace function followup_claim_due(max_rows int default 25)
returns setof jsonb language plpgsql as $$
declare
  row_id uuid;
begin
  for row_id in
    with due as (
      select e.id
      from followup_enrollments e
      join followup_contacts c on c.id = e.contact_id
      join followup_sequences q on q.id = e.sequence_id
      where e.status = 'active'
        and e.next_run_at is not null
        and e.next_run_at <= now()
        and (e.locked_until is null or e.locked_until < now())
        and c.opted_out_at is null
        and q.is_active
      order by e.next_run_at
      limit greatest(coalesce(max_rows, 25), 1)
      for update of e skip locked
    )
    update followup_enrollments e
    set locked_until = now() + interval '5 minutes'
    from due where e.id = due.id
    returning e.id
  loop
    return query
    select jsonb_build_object(
      'enrollment_id', e.id,
      'step_id', s.id,
      'step_position', s.position,
      'step_label', s.label,
      'is_first_step', not exists (
        select 1 from followup_messages m where m.enrollment_id = e.id and m.direction = 'outbound'
      ),
      'language', e.language,
      'body_en', s.body_en,
      'body_es', s.body_es,
      'body_en_night', s.body_en_night,
      'body_es_night', s.body_es_night,
      'is_night', (
        select extract(hour from (now() at time zone coalesce(nullif(q.timezone, ''), 'America/Chicago')))::int
               >= setting_int('night_starts_hour', 21)
            or extract(hour from (now() at time zone coalesce(nullif(q.timezone, ''), 'America/Chicago')))::int
               < setting_int('night_ends_hour', 8)
      ),
      'append_opt_out_notice', q.append_opt_out_notice,
      'quo_number_id', coalesce(q.quo_number_id, setting_text('default_quo_number_id', null)),
      'to_number', c.phone_e164,
      'contact_id', c.id,
      'first_name', c.first_name,
      'last_name', c.last_name,
      'case_reference', e.case_reference,
      'case_type', coalesce(e.case_type, c.case_type),
      'assigned_slack_user_id', e.assigned_slack_user_id,
      'assigned_slack_user_name', e.assigned_slack_user_name,
      'slack_channel_id', e.slack_channel_id,
      'slack_thread_ts', e.slack_thread_ts,
      'sequence_name', q.name,
      'sequence_slug', q.slug,
      'timezone', q.timezone
    )
    from followup_enrollments e
    join followup_sequences q on q.id = e.sequence_id
    join followup_contacts c on c.id = e.contact_id
    join followup_steps s on s.sequence_id = e.sequence_id
      and s.position = e.next_position and s.is_active
    where e.id = row_id;
  end loop;
end;
$$;
