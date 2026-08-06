-- A series started outside the sending window used to fire its backlog all at
-- once when the window reopened.
--
-- Delays are measured from the start of the series, so a series begun at 11pm
-- with touches at 0, +4h and +8h has all three of those times in the past by
-- 9am the next morning. Each one then resolved to "now", and the dispatcher sent
-- them one cycle apart — three texts to a client inside two minutes.
--
-- Two changes, both only affecting times computed from here on. No existing
-- next_run_at is touched, so nothing already scheduled moves.

-- 1. Anchor the rhythm to when the client actually received the first text
--    rather than when somebody pressed start. For a series begun inside the
--    window these are the same moment and nothing changes; for one begun at
--    11pm it means "+4h" is four hours after they heard from us, which is what
--    the copy is written to assume.
-- 2. Never schedule a text within min_gap_minutes of the previous one, whatever
--    the arithmetic says. This is the backstop that makes a burst impossible
--    even if a sequence is edited into overlapping delays.
create or replace function followup_step_due_at(
  enrollment followup_enrollments,
  seq followup_sequences,
  step followup_steps
)
returns timestamptz language sql stable as $$
  select followup_shift_into_window(
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
  );
$$;

-- followup_record_send computes the next due time from a snapshot of the
-- enrollment taken before the update, so enrollment.last_sent_at is the send
-- before this one. The gap has to be measured from the send that just happened,
-- so move it forward on the snapshot first. This is the only change to the
-- function; everything else is as it was.
create or replace function followup_record_send(payload jsonb)
returns jsonb language plpgsql as $$
declare
  enrollment followup_enrollments;
  seq followup_sequences;
  next_step followup_steps;
  v_ok boolean := coalesce((payload ->> 'ok')::boolean, false);
  v_enrollment_id uuid := (payload ->> 'enrollment_id')::uuid;
  v_retry_at timestamptz;
  v_max_attempts int := setting_int('max_send_attempts', 3);
  v_retry_minutes int := setting_int('retry_delay_minutes', 15);
begin
  select * into enrollment from followup_enrollments where id = v_enrollment_id for update;
  if enrollment.id is null then
    return jsonb_build_object('ok', false, 'reason', 'enrollment_not_found');
  end if;
  select * into seq from followup_sequences where id = enrollment.sequence_id;

  insert into followup_messages (
    enrollment_id, contact_id, step_id, direction, language, body, status,
    quo_message_id, quo_number_id, from_number, to_number, segments, error, sent_at
  ) values (
    enrollment.id, enrollment.contact_id, nullif(payload ->> 'step_id', '')::uuid,
    'outbound', enrollment.language, coalesce(payload ->> 'body', ''),
    case when v_ok then 'sent' else 'failed' end,
    nullif(payload ->> 'quo_message_id', ''),
    nullif(payload ->> 'quo_number_id', ''),
    nullif(payload ->> 'from_number', ''),
    nullif(payload ->> 'to_number', ''),
    nullif(payload ->> 'segments', '')::int,
    nullif(payload ->> 'error', ''),
    case when v_ok then now() else null end
  );

  if not v_ok then
    if enrollment.attempt_count + 1 >= v_max_attempts then
      update followup_enrollments
      set status = 'failed', attempt_count = attempt_count + 1, locked_until = null,
          end_reason = coalesce(nullif(payload ->> 'error', ''), 'send_failed'), ended_by = 'system'
      where id = enrollment.id;

      insert into followup_events (enrollment_id, contact_id, kind, detail, actor)
      values (enrollment.id, enrollment.contact_id, 'send_failed_final',
              jsonb_build_object('error', payload ->> 'error'), 'system');

      return jsonb_build_object('ok', false, 'reason', 'send_failed', 'final', true,
                                'enrollment_id', enrollment.id,
                                'assigned_slack_user_id', enrollment.assigned_slack_user_id,
                                'slack_channel_id', enrollment.slack_channel_id,
                                'slack_thread_ts', enrollment.slack_thread_ts);
    end if;

    v_retry_at := now() + make_interval(mins => v_retry_minutes);
    update followup_enrollments
    set attempt_count = attempt_count + 1, locked_until = null, next_run_at = v_retry_at
    where id = enrollment.id;

    insert into followup_events (enrollment_id, contact_id, kind, detail, actor)
    values (enrollment.id, enrollment.contact_id, 'send_failed',
            jsonb_build_object('error', payload ->> 'error', 'retry_at', v_retry_at), 'system');

    return jsonb_build_object('ok', false, 'reason', 'send_failed', 'final', false,
                              'retry_at', v_retry_at, 'enrollment_id', enrollment.id);
  end if;

  update followup_contacts set last_outbound_at = now() where id = enrollment.contact_id;

  insert into followup_events (enrollment_id, contact_id, kind, detail, actor)
  values (enrollment.id, enrollment.contact_id, 'sent',
          jsonb_build_object('step_position', enrollment.next_position,
                             'quo_message_id', payload ->> 'quo_message_id'), 'system');

  select * into next_step from followup_steps
    where sequence_id = enrollment.sequence_id and is_active and position > enrollment.next_position
    order by position limit 1;

  if next_step.id is null then
    update followup_enrollments
    set status = 'completed', last_sent_at = now(), attempt_count = 0,
        locked_until = null, end_reason = 'sequence_complete', ended_by = 'system'
    where id = enrollment.id
    returning * into enrollment;

    return jsonb_build_object('ok', true, 'completed', true,
                              'enrollment_id', enrollment.id,
                              'assigned_slack_user_id', enrollment.assigned_slack_user_id,
                              'slack_channel_id', enrollment.slack_channel_id,
                              'slack_thread_ts', enrollment.slack_thread_ts);
  end if;

  -- The text that just went out is the one the gap is measured from.
  enrollment.last_sent_at := now();

  update followup_enrollments
  set next_position = next_step.position,
      next_run_at = followup_step_due_at(enrollment, seq, next_step),
      last_sent_at = now(), attempt_count = 0, locked_until = null
  where id = enrollment.id
  returning * into enrollment;

  return jsonb_build_object('ok', true, 'completed', false,
                            'enrollment_id', enrollment.id,
                            'next_position', enrollment.next_position,
                            'next_run_at', enrollment.next_run_at);
end;
$$;
