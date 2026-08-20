-- Leads arriving in a Slack channel from several form sources, routed to a
-- sequence by their content, answered immediately whatever the hour.
--
-- Three separate capabilities, all optional and all off until switched on:
--
--  1. A sequence can answer immediately, ignoring its sending window for the
--     first text only. A lead who filled in a form thirty seconds ago is not
--     being cold-texted; texts two onwards still respect the window.
--  2. A step can carry a different body for the middle of the night, because
--     "we just received your message" reads wrong at 3am.
--  3. An enrollment records where the lead came from and how it was routed, so
--     a wrong track is visible rather than mysterious.

alter table followup_sequences
  add column if not exists respond_immediately boolean not null default false;

comment on column followup_sequences.respond_immediately is
  'First text ignores the sending window. Later texts do not.';

alter table followup_steps
  add column if not exists body_en_night text,
  add column if not exists body_es_night text;

comment on column followup_steps.body_en_night is
  'Used instead of body_en when the text goes out during the night window. Null falls back to body_en.';

alter table followup_enrollments
  add column if not exists lead_source text,
  add column if not exists lead_detail jsonb;

comment on column followup_enrollments.lead_detail is
  'How this lead was routed: the classifier''s choice, its confidence and reasoning, '
  'and the Slack message it read. Kept so a wrong track can be understood.';

-- 'lead' joins the ways a series can start.
alter table followup_enrollments drop constraint if exists followup_enrollments_source;
alter table followup_enrollments add constraint followup_enrollments_source
  check (source in ('command', 'message_action', 'mention', 'dashboard', 'lead'));

-- Respect respond_immediately on the first text only. Everything else is as
-- migration 005 left it: the rhythm follows the first text the client actually
-- received, and no two texts land within min_gap_minutes of each other.
create or replace function followup_step_due_at(
  enrollment followup_enrollments,
  seq followup_sequences,
  step followup_steps
)
returns timestamptz language sql stable as $$
  select case
    -- The first text of an immediate-response sequence, not yet sent: now.
    when seq.respond_immediately
     and not exists (
       select 1 from followup_messages m
        where m.enrollment_id = enrollment.id
          and m.direction = 'outbound' and m.status <> 'failed')
    then greatest(enrollment.started_at + make_interval(mins => step.delay_minutes), now())
    else followup_shift_into_window(
      greatest(
        coalesce(
          (select min(m.created_at) from followup_messages m
            where m.enrollment_id = enrollment.id
              and m.direction = 'outbound' and m.status <> 'failed'),
          enrollment.started_at
        ) + make_interval(mins => step.delay_minutes),
        coalesce(enrollment.last_sent_at, '-infinity'::timestamptz)
          + make_interval(mins => setting_int('min_gap_minutes', 60)),
        now()
      ),
      seq.timezone, seq.quiet_hours_start, seq.quiet_hours_end, seq.send_days
    )
  end;
$$;

-- Carry the lead's provenance onto the enrollment.
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

  insert into followup_contacts as target (phone_e164, first_name, last_name, language)
  values (
    v_phone,
    nullif(btrim(coalesce(payload ->> 'first_name', '')), ''),
    nullif(btrim(coalesce(payload ->> 'last_name', '')), ''),
    coalesce(nullif(lower(btrim(coalesce(payload ->> 'language', ''))), ''), 'en')
  )
  on conflict (phone_e164) do update
    set first_name = coalesce(nullif(btrim(coalesce(excluded.first_name, '')), ''), target.first_name),
        last_name = coalesce(nullif(btrim(coalesce(excluded.last_name, '')), ''), target.last_name),
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
    lead_source, lead_detail, next_position
  ) values (
    seq.id, contact.id, v_language, v_assignee,
    nullif(btrim(coalesce(payload ->> 'assigned_slack_user_name', '')), ''),
    nullif(btrim(coalesce(payload ->> 'started_by_slack_user_id', '')), ''),
    nullif(btrim(coalesce(payload ->> 'slack_channel_id', '')), ''),
    nullif(btrim(coalesce(payload ->> 'slack_thread_ts', '')), ''),
    v_source,
    nullif(btrim(coalesce(payload ->> 'case_reference', '')), ''),
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
    'slack_channel_id', enrollment.slack_channel_id,
    'slack_thread_ts', enrollment.slack_thread_ts,
    'sequence', jsonb_build_object('slug', seq.slug, 'name', seq.name, 'timezone', seq.timezone)
  );
end;
$$;

-- The dispatcher needs to know, per claimed text, whether the night body applies
-- and which one to use. Adding it here keeps the decision on the same clock as
-- the rest of the scheduling rather than on the Node process's.
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
      -- Whether the client's local clock says it is the middle of the night.
      -- The window wraps midnight, so this is an OR rather than a BETWEEN.
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
