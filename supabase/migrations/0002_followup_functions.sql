-- State transitions for the follow-up system.
--
-- All of them live in the database rather than in the edge functions so that
-- "stop this series" is a single atomic statement no matter what triggered it:
-- a Slack button, an inbound text, a missed-call webhook, or the admin UI. The
-- edge functions are left doing only what the database cannot: HTTP to Quo and
-- Slack.
--
-- Every function is security definer and granted to service_role only. The
-- browser never calls them; the admin UI works through RLS on the tables.

-- ----------------------------------------------------------------- helpers

-- Accepts what a paralegal actually types into Slack: (512) 555-0123,
-- 512-555-0123, 15125550123, +1 512 555 0123. Returns null when it cannot be
-- read as a US/E.164 number, which the callers treat as "ask them again".
create or replace function public.followup_normalize_phone(raw text)
returns text
language plpgsql
immutable
as $$
declare
  digits text;
begin
  if raw is null then return null; end if;

  if left(btrim(raw), 1) = '+' then
    digits := regexp_replace(btrim(raw), '[^0-9]', '', 'g');
    if char_length(digits) between 8 and 15 then return '+' || digits; end if;
    return null;
  end if;

  digits := regexp_replace(raw, '[^0-9]', '', 'g');
  if char_length(digits) = 10 then return '+1' || digits; end if;
  if char_length(digits) = 11 and left(digits, 1) = '1' then return '+' || digits; end if;
  if char_length(digits) between 11 and 15 then return '+' || digits; end if;
  return null;
end;
$$;

-- Moves a send time forward into the sequence's allowed local window. A text
-- scheduled for 2am lands at 8am the same morning; one scheduled for 10pm
-- Saturday lands at 8am on the next allowed day.
create or replace function public.followup_shift_into_window(
  earliest timestamptz,
  tz text,
  start_hour int,
  end_hour int,
  allowed_days smallint[]
)
returns timestamptz
language plpgsql
stable
as $$
declare
  candidate timestamp;
  guard int := 0;
begin
  if earliest is null then return null; end if;
  if tz is null or tz = '' then tz := 'America/Chicago'; end if;
  if start_hour is null then start_hour := 0; end if;
  if end_hour is null then end_hour := 24; end if;
  if end_hour <= start_hour then return earliest; end if;
  if allowed_days is null or cardinality(allowed_days) = 0 then
    allowed_days := array[1, 2, 3, 4, 5, 6, 7]::smallint[];
  end if;

  candidate := earliest at time zone tz;

  loop
    guard := guard + 1;
    exit when guard > 21;

    if extract(hour from candidate)::int >= end_hour then
      candidate := date_trunc('day', candidate) + interval '1 day' + make_interval(hours => start_hour);
      continue;
    end if;

    if extract(hour from candidate)::int < start_hour then
      candidate := date_trunc('day', candidate) + make_interval(hours => start_hour);
    end if;

    if not (extract(isodow from candidate)::smallint = any (allowed_days)) then
      candidate := date_trunc('day', candidate) + interval '1 day' + make_interval(hours => start_hour);
      continue;
    end if;

    exit;
  end loop;

  return candidate at time zone tz;
end;
$$;

-- Schedules step `position` of an enrollment, or returns null when the sequence
-- has no further active steps.
create or replace function public.followup_step_due_at(
  enrollment public.followup_enrollments,
  seq public.followup_sequences,
  step public.followup_steps
)
returns timestamptz
language sql
stable
as $$
  select public.followup_shift_into_window(
    greatest(enrollment.started_at + make_interval(mins => step.delay_minutes), now()),
    seq.timezone, seq.quiet_hours_start, seq.quiet_hours_end, seq.send_days
  );
$$;

-- ------------------------------------------------------------------ enroll

-- payload: { phone, sequence_slug?, language?, first_name?, last_name?,
--            assigned_slack_user_id, assigned_slack_user_name?,
--            started_by_slack_user_id?, slack_channel_id?, case_reference? }
create or replace function public.followup_enroll(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  seq public.followup_sequences;
  contact public.followup_contacts;
  step public.followup_steps;
  enrollment public.followup_enrollments;
  existing public.followup_enrollments;
  v_phone text;
  v_language text;
  v_assignee text;
  v_step_count int;
begin
  v_phone := public.followup_normalize_phone(payload ->> 'phone');
  if v_phone is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_phone');
  end if;

  v_assignee := nullif(btrim(coalesce(payload ->> 'assigned_slack_user_id', '')), '');
  if v_assignee is null then
    return jsonb_build_object('ok', false, 'reason', 'missing_assignee');
  end if;

  if payload ? 'sequence_slug' and nullif(btrim(payload ->> 'sequence_slug'), '') is not null then
    select * into seq from public.followup_sequences
      where slug = lower(btrim(payload ->> 'sequence_slug'));
  else
    select * into seq from public.followup_sequences where is_default order by created_at limit 1;
  end if;

  if seq.id is null then
    return jsonb_build_object('ok', false, 'reason', 'sequence_not_found');
  end if;
  if not seq.is_active then
    return jsonb_build_object('ok', false, 'reason', 'sequence_inactive',
                              'sequence', jsonb_build_object('slug', seq.slug, 'name', seq.name));
  end if;

  select count(*) into v_step_count
  from public.followup_steps where sequence_id = seq.id and is_active;
  if v_step_count = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_steps',
                              'sequence', jsonb_build_object('slug', seq.slug, 'name', seq.name));
  end if;

  -- Upsert the contact, preserving details we already know when the new request
  -- omits them.
  insert into public.followup_contacts as target (phone_e164, first_name, last_name, language)
  values (
    v_phone,
    nullif(btrim(coalesce(payload ->> 'first_name', '')), ''),
    nullif(btrim(coalesce(payload ->> 'last_name', '')), ''),
    coalesce(nullif(lower(btrim(coalesce(payload ->> 'language', ''))), ''), 'en')
  )
  on conflict (phone_e164) do update
    set first_name = coalesce(excluded.first_name, target.first_name),
        last_name = coalesce(excluded.last_name, target.last_name),
        language = case
          when nullif(btrim(coalesce(payload ->> 'language', '')), '') is not null
          then excluded.language
          else target.language
        end
  returning * into contact;

  if contact.opted_out_at is not null then
    return jsonb_build_object(
      'ok', false, 'reason', 'opted_out',
      'contact', to_jsonb(contact) - 'notes',
      'opted_out_at', contact.opted_out_at
    );
  end if;

  select * into existing from public.followup_enrollments
    where contact_id = contact.id and status = 'active' limit 1;
  if existing.id is not null then
    return jsonb_build_object(
      'ok', false, 'reason', 'already_active',
      'enrollment_id', existing.id,
      'assigned_slack_user_id', existing.assigned_slack_user_id,
      'sequence_id', existing.sequence_id
    );
  end if;

  v_language := coalesce(
    nullif(lower(btrim(coalesce(payload ->> 'language', ''))), ''),
    contact.language,
    'en'
  );
  if v_language not in ('en', 'es') then v_language := 'en'; end if;

  insert into public.followup_enrollments (
    sequence_id, contact_id, language, assigned_slack_user_id, assigned_slack_user_name,
    started_by_slack_user_id, slack_channel_id, case_reference, next_position
  ) values (
    seq.id, contact.id, v_language, v_assignee,
    nullif(btrim(coalesce(payload ->> 'assigned_slack_user_name', '')), ''),
    nullif(btrim(coalesce(payload ->> 'started_by_slack_user_id', '')), ''),
    nullif(btrim(coalesce(payload ->> 'slack_channel_id', '')), ''),
    nullif(btrim(coalesce(payload ->> 'case_reference', '')), ''),
    1
  ) returning * into enrollment;

  select * into step from public.followup_steps
    where sequence_id = seq.id and is_active order by position limit 1;

  update public.followup_enrollments
  set next_position = step.position,
      next_run_at = public.followup_step_due_at(enrollment, seq, step)
  where id = enrollment.id
  returning * into enrollment;

  insert into public.followup_events (enrollment_id, contact_id, kind, detail, actor)
  values (enrollment.id, contact.id, 'enrolled',
          jsonb_build_object('sequence', seq.slug, 'language', v_language,
                             'steps', v_step_count, 'first_send_at', enrollment.next_run_at),
          coalesce(payload ->> 'started_by_slack_user_id', v_assignee));

  return jsonb_build_object(
    'ok', true,
    'enrollment_id', enrollment.id,
    'contact_id', contact.id,
    'phone', contact.phone_e164,
    'first_name', contact.first_name,
    'language', v_language,
    'assigned_slack_user_id', enrollment.assigned_slack_user_id,
    'next_run_at', enrollment.next_run_at,
    'step_count', v_step_count,
    'sequence', jsonb_build_object('slug', seq.slug, 'name', seq.name)
  );
end;
$$;

-- -------------------------------------------------------------- claim work

-- Returns the enrollments whose next text is due, locking each one for five
-- minutes so two overlapping cron runs cannot send the same step twice.
create or replace function public.followup_claim_due(max_rows int default 25)
returns setof jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_id uuid;
begin
  for row_id in
    with due as (
      select e.id
      from public.followup_enrollments e
      join public.followup_contacts c on c.id = e.contact_id
      where e.status = 'active'
        and e.next_run_at is not null
        and e.next_run_at <= now()
        and (e.locked_until is null or e.locked_until < now())
        and c.opted_out_at is null
      order by e.next_run_at
      limit greatest(coalesce(max_rows, 25), 1)
      for update of e skip locked
    )
    update public.followup_enrollments e
    set locked_until = now() + interval '5 minutes'
    from due
    where e.id = due.id
    returning e.id
  loop
    return query
    select jsonb_build_object(
      'enrollment_id', e.id,
      'step_id', s.id,
      'step_position', s.position,
      'step_label', s.label,
      'is_first_step', not exists (
        select 1 from public.followup_messages m
        where m.enrollment_id = e.id and m.direction = 'outbound'
      ),
      'language', e.language,
      'body_en', s.body_en,
      'body_es', s.body_es,
      'append_opt_out_notice', q.append_opt_out_notice,
      'from_number', q.quo_from_number,
      'quo_phone_number_id', q.quo_phone_number_id,
      'to_number', c.phone_e164,
      'contact_id', c.id,
      'first_name', c.first_name,
      'last_name', c.last_name,
      'case_reference', e.case_reference,
      'assigned_slack_user_id', e.assigned_slack_user_id,
      'assigned_slack_user_name', e.assigned_slack_user_name,
      'slack_channel_id', e.slack_channel_id,
      'sequence_name', q.name,
      'sequence_slug', q.slug
    )
    from public.followup_enrollments e
    join public.followup_sequences q on q.id = e.sequence_id
    join public.followup_contacts c on c.id = e.contact_id
    join public.followup_steps s on s.sequence_id = e.sequence_id
      and s.position = e.next_position and s.is_active
    where e.id = row_id;
  end loop;
end;
$$;

-- ------------------------------------------------------------- record send

-- payload: { enrollment_id, step_id, ok, body, quo_message_id?, error?,
--            from_number?, to_number?, quo_phone_number_id? }
create or replace function public.followup_record_send(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  enrollment public.followup_enrollments;
  seq public.followup_sequences;
  next_step public.followup_steps;
  v_ok boolean := coalesce((payload ->> 'ok')::boolean, false);
  v_enrollment_id uuid := (payload ->> 'enrollment_id')::uuid;
  v_retry_at timestamptz;
begin
  select * into enrollment from public.followup_enrollments where id = v_enrollment_id for update;
  if enrollment.id is null then
    return jsonb_build_object('ok', false, 'reason', 'enrollment_not_found');
  end if;
  select * into seq from public.followup_sequences where id = enrollment.sequence_id;

  insert into public.followup_messages (
    enrollment_id, contact_id, step_id, direction, language, body, status,
    quo_message_id, quo_phone_number_id, from_number, to_number, error, sent_at
  ) values (
    enrollment.id, enrollment.contact_id, nullif(payload ->> 'step_id', '')::uuid,
    'outbound', enrollment.language, coalesce(payload ->> 'body', ''),
    case when v_ok then 'sent' else 'failed' end,
    nullif(payload ->> 'quo_message_id', ''),
    nullif(payload ->> 'quo_phone_number_id', ''),
    nullif(payload ->> 'from_number', ''),
    nullif(payload ->> 'to_number', ''),
    nullif(payload ->> 'error', ''),
    case when v_ok then now() else null end
  );

  if not v_ok then
    -- Three tries fifteen minutes apart, then the series is parked as failed and
    -- the assigned user is told, rather than retrying a bad number forever.
    if enrollment.attempt_count + 1 >= 3 then
      update public.followup_enrollments
      set status = 'failed', attempt_count = attempt_count + 1, locked_until = null,
          end_reason = coalesce(nullif(payload ->> 'error', ''), 'send_failed'), ended_by = 'system'
      where id = enrollment.id;

      insert into public.followup_events (enrollment_id, contact_id, kind, detail, actor)
      values (enrollment.id, enrollment.contact_id, 'send_failed_final',
              jsonb_build_object('error', payload ->> 'error'), 'system');

      return jsonb_build_object('ok', false, 'reason', 'send_failed', 'final', true,
                                'enrollment_id', enrollment.id,
                                'assigned_slack_user_id', enrollment.assigned_slack_user_id,
                                'slack_channel_id', enrollment.slack_channel_id);
    end if;

    v_retry_at := now() + interval '15 minutes';
    update public.followup_enrollments
    set attempt_count = attempt_count + 1, locked_until = null, next_run_at = v_retry_at
    where id = enrollment.id;

    insert into public.followup_events (enrollment_id, contact_id, kind, detail, actor)
    values (enrollment.id, enrollment.contact_id, 'send_failed',
            jsonb_build_object('error', payload ->> 'error', 'retry_at', v_retry_at), 'system');

    return jsonb_build_object('ok', false, 'reason', 'send_failed', 'final', false,
                              'retry_at', v_retry_at, 'enrollment_id', enrollment.id);
  end if;

  update public.followup_contacts set last_outbound_at = now() where id = enrollment.contact_id;

  insert into public.followup_events (enrollment_id, contact_id, kind, detail, actor)
  values (enrollment.id, enrollment.contact_id, 'sent',
          jsonb_build_object('step_position', enrollment.next_position,
                             'quo_message_id', payload ->> 'quo_message_id'), 'system');

  select * into next_step from public.followup_steps
    where sequence_id = enrollment.sequence_id
      and is_active and position > enrollment.next_position
    order by position limit 1;

  if next_step.id is null then
    update public.followup_enrollments
    set status = 'completed', last_sent_at = now(), attempt_count = 0,
        locked_until = null, end_reason = 'sequence_complete', ended_by = 'system'
    where id = enrollment.id
    returning * into enrollment;

    return jsonb_build_object('ok', true, 'completed', true,
                              'enrollment_id', enrollment.id,
                              'assigned_slack_user_id', enrollment.assigned_slack_user_id,
                              'slack_channel_id', enrollment.slack_channel_id);
  end if;

  update public.followup_enrollments
  set next_position = next_step.position,
      next_run_at = public.followup_step_due_at(enrollment, seq, next_step),
      last_sent_at = now(), attempt_count = 0, locked_until = null
  where id = enrollment.id
  returning * into enrollment;

  return jsonb_build_object('ok', true, 'completed', false,
                            'enrollment_id', enrollment.id,
                            'next_position', enrollment.next_position,
                            'next_run_at', enrollment.next_run_at);
end;
$$;

-- -------------------------------------------------------------------- stop

-- payload: { enrollment_id? | phone?, reason, actor?, enforce_assignment? }
--
-- reason is one of reply, call, manual, opt_out. `enforce_assignment` is what
-- backs the rule that only the assigned paralegal can stop a series from Slack;
-- an inbound text or the admin UI passes false.
create or replace function public.followup_stop(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  enrollment public.followup_enrollments;
  contact public.followup_contacts;
  v_reason text := coalesce(nullif(payload ->> 'reason', ''), 'manual');
  v_actor text := nullif(payload ->> 'actor', '');
  v_status text;
  v_enforce boolean := coalesce((payload ->> 'enforce_assignment')::boolean, false);
  v_supervisor boolean := false;
  v_phone text;
begin
  v_status := case v_reason
    when 'reply' then 'stopped_reply'
    when 'call' then 'stopped_call'
    when 'opt_out' then 'stopped_opt_out'
    else 'stopped_manual'
  end;

  if payload ? 'enrollment_id' and nullif(payload ->> 'enrollment_id', '') is not null then
    select * into enrollment from public.followup_enrollments
      where id = (payload ->> 'enrollment_id')::uuid for update;
  else
    v_phone := public.followup_normalize_phone(payload ->> 'phone');
    if v_phone is null then
      return jsonb_build_object('ok', false, 'reason', 'invalid_phone');
    end if;
    select e.* into enrollment
    from public.followup_enrollments e
    join public.followup_contacts c on c.id = e.contact_id
    where c.phone_e164 = v_phone and e.status = 'active'
    limit 1
    for update of e;
  end if;

  if enrollment.id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_active_enrollment');
  end if;
  if enrollment.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'not_active', 'status', enrollment.status);
  end if;

  if v_enforce and v_actor is not null and v_actor <> enrollment.assigned_slack_user_id then
    select coalesce(is_supervisor, false) into v_supervisor
    from public.followup_operators where slack_user_id = v_actor and is_active;
    if not coalesce(v_supervisor, false) then
      return jsonb_build_object(
        'ok', false, 'reason', 'not_assigned',
        'assigned_slack_user_id', enrollment.assigned_slack_user_id
      );
    end if;
  end if;

  update public.followup_enrollments
  set status = v_status, end_reason = v_reason, ended_by = coalesce(v_actor, 'system')
  where id = enrollment.id
  returning * into enrollment;

  select * into contact from public.followup_contacts where id = enrollment.contact_id;

  return jsonb_build_object(
    'ok', true,
    'enrollment_id', enrollment.id,
    'status', enrollment.status,
    'reason', v_reason,
    'phone', contact.phone_e164,
    'first_name', contact.first_name,
    'assigned_slack_user_id', enrollment.assigned_slack_user_id,
    'slack_channel_id', enrollment.slack_channel_id,
    'sent_count', (
      select count(*) from public.followup_messages
      where enrollment_id = enrollment.id and direction = 'outbound' and status <> 'failed'
    )
  );
end;
$$;

-- ---------------------------------------------------------- inbound events

-- payload: { phone, body?, quo_message_id?, kind?, from_number?, to_number?,
--            quo_phone_number_id?, is_stop?, is_start? }
--
-- kind is 'message' or 'call'. The caller does keyword detection (it needs the
-- same word lists the confirmation copy uses) and passes is_stop / is_start.
create or replace function public.followup_record_inbound(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  contact public.followup_contacts;
  enrollment public.followup_enrollments;
  v_phone text;
  v_kind text := coalesce(nullif(payload ->> 'kind', ''), 'message');
  v_is_stop boolean := coalesce((payload ->> 'is_stop')::boolean, false);
  v_is_start boolean := coalesce((payload ->> 'is_start')::boolean, false);
  v_message_id text := nullif(payload ->> 'quo_message_id', '');
  v_action text;
  v_stop jsonb;
begin
  v_phone := public.followup_normalize_phone(payload ->> 'phone');
  if v_phone is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_phone');
  end if;

  -- Replayed webhook: nothing to do, and in particular do not re-send the STOP
  -- confirmation text.
  if v_message_id is not null
     and exists (select 1 from public.followup_messages where quo_message_id = v_message_id) then
    return jsonb_build_object('ok', true, 'duplicate', true, 'action', 'none');
  end if;

  insert into public.followup_contacts (phone_e164, last_inbound_at)
  values (v_phone, now())
  on conflict (phone_e164) do update set last_inbound_at = now()
  returning * into contact;

  if v_kind = 'message' then
    insert into public.followup_messages (
      contact_id, enrollment_id, direction, body, status,
      quo_message_id, quo_phone_number_id, from_number, to_number
    )
    select contact.id,
           (select id from public.followup_enrollments
            where contact_id = contact.id order by created_at desc limit 1),
           'inbound', coalesce(payload ->> 'body', ''), 'received',
           v_message_id, nullif(payload ->> 'quo_phone_number_id', ''),
           nullif(payload ->> 'from_number', ''), nullif(payload ->> 'to_number', '');
  end if;

  -- START only means "put me back on the list" when they are actually off it.
  -- A client who answers "start" or "yes" to a live series is just replying,
  -- and a reply has to stop the series.
  if v_is_start and contact.opted_out_at is not null then
    update public.followup_contacts
    set opted_out_at = null, opted_out_reason = null, opted_in_at = now()
    where id = contact.id
    returning * into contact;

    insert into public.followup_events (contact_id, kind, detail, actor)
    values (contact.id, 'opt_in', jsonb_build_object('body', payload ->> 'body'), 'contact');

    return jsonb_build_object('ok', true, 'action', 'opt_in', 'phone', contact.phone_e164,
                              'language', contact.language, 'first_name', contact.first_name);
  end if;

  if v_is_stop then
    update public.followup_contacts
    set opted_out_at = now(), opted_out_reason = 'keyword'
    where id = contact.id
    returning * into contact;

    insert into public.followup_events (contact_id, kind, detail, actor)
    values (contact.id, 'opt_out', jsonb_build_object('body', payload ->> 'body'), 'contact');

    v_action := 'opt_out';
  else
    -- Any other reply, or an inbound call, means the client is back in touch.
    v_action := case when v_kind = 'call' then 'call' else 'reply' end;
  end if;

  select * into enrollment from public.followup_enrollments
    where contact_id = contact.id and status = 'active' limit 1;

  if enrollment.id is not null then
    v_stop := public.followup_stop(jsonb_build_object(
      'enrollment_id', enrollment.id,
      'reason', case when v_action = 'opt_out' then 'opt_out' else v_action end,
      'actor', 'contact'
    ));
  end if;

  return jsonb_build_object(
    'ok', true,
    'action', v_action,
    'phone', contact.phone_e164,
    'language', contact.language,
    'first_name', contact.first_name,
    'body', payload ->> 'body',
    'stopped', v_stop,
    'enrollment_id', enrollment.id,
    'assigned_slack_user_id', enrollment.assigned_slack_user_id,
    'slack_channel_id', enrollment.slack_channel_id
  );
end;
$$;

-- Carrier delivery receipts. Failures are worth surfacing because a hard bounce
-- usually means a landline, which no amount of retrying will fix.
create or replace function public.followup_record_delivery(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message_id text := nullif(payload ->> 'quo_message_id', '');
  v_status text := nullif(payload ->> 'status', '');
  updated public.followup_messages;
begin
  if v_message_id is null or v_status is null then
    return jsonb_build_object('ok', false, 'reason', 'missing_fields');
  end if;
  if v_status not in ('sent', 'delivered', 'undelivered', 'failed') then
    return jsonb_build_object('ok', false, 'reason', 'unknown_status', 'status', v_status);
  end if;

  update public.followup_messages
  set status = v_status, error = coalesce(nullif(payload ->> 'error', ''), error)
  where quo_message_id = v_message_id
  returning * into updated;

  if updated.id is null then
    return jsonb_build_object('ok', false, 'reason', 'message_not_found');
  end if;

  if v_status in ('undelivered', 'failed') then
    insert into public.followup_events (enrollment_id, contact_id, kind, detail, actor)
    values (updated.enrollment_id, updated.contact_id, 'delivery_failed',
            jsonb_build_object('status', v_status, 'error', payload ->> 'error'), 'quo');
  end if;

  return jsonb_build_object('ok', true, 'status', v_status,
                            'enrollment_id', updated.enrollment_id);
end;
$$;

-- ------------------------------------------------------------------ grants

-- The browser never calls these. Only the edge functions, which authenticate
-- with the service role, may execute them.
do $$
declare
  target text;
begin
  foreach target in array array[
    'public.followup_enroll(jsonb)',
    'public.followup_claim_due(int)',
    'public.followup_record_send(jsonb)',
    'public.followup_stop(jsonb)',
    'public.followup_record_inbound(jsonb)',
    'public.followup_record_delivery(jsonb)'
  ] loop
    execute format('revoke all on function %s from public', target);
    execute format('revoke all on function %s from anon, authenticated', target);
    execute format('grant execute on function %s to service_role', target);
  end loop;
end;
$$;
