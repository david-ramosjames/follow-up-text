-- Exercises the follow-up state machine end to end against a real database.
--
-- Run with `npm run test:db` (needs DATABASE_URL), or directly:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/db/state_machine.sql
--
-- Every check raises on failure, so a run that reaches ALL TESTS PASSED is the
-- whole result. It writes real rows, so point it at a scratch database.

create or replace function pg_temp.check(label text, condition boolean)
returns void language plpgsql as $$
begin
  if condition is not true then
    raise exception 'FAILED: %', label;
  end if;
  raise notice 'ok  %', label;
end;
$$;

/* ------------------------------------------------------------ phone parsing */

do $$
begin
  perform pg_temp.check('ten digits get +1',
    followup_normalize_phone('5125550123') = '+15125550123');
  perform pg_temp.check('formatted US number',
    followup_normalize_phone('(512) 555-0123') = '+15125550123');
  perform pg_temp.check('leading 1',
    followup_normalize_phone('1-512-555-0123') = '+15125550123');
  perform pg_temp.check('already E.164',
    followup_normalize_phone('+15125550123') = '+15125550123');
  perform pg_temp.check('spaces in E.164',
    followup_normalize_phone('+1 512 555 0123') = '+15125550123');
  perform pg_temp.check('garbage is rejected', followup_normalize_phone('call me') is null);
  perform pg_temp.check('too short is rejected', followup_normalize_phone('5550123') is null);
end;
$$;

/* -------------------------------------------------------------- quiet hours */

do $$
declare
  tz text := 'America/Chicago';
  days smallint[] := array[1,2,3,4,5,6,7]::smallint[];
  weekdays smallint[] := array[1,2,3,4,5]::smallint[];
  shifted timestamptz;
begin
  shifted := followup_shift_into_window(timestamptz '2026-08-03 02:30:00-05', tz, 8, 20, days);
  perform pg_temp.check('pre-dawn moves to the opening hour',
    (shifted at time zone tz) = timestamp '2026-08-03 08:00:00');

  shifted := followup_shift_into_window(timestamptz '2026-08-03 22:15:00-05', tz, 8, 20, days);
  perform pg_temp.check('late night moves to the next morning',
    (shifted at time zone tz) = timestamp '2026-08-04 08:00:00');

  shifted := followup_shift_into_window(timestamptz '2026-08-03 14:00:00-05', tz, 8, 20, days);
  perform pg_temp.check('mid-afternoon is untouched',
    (shifted at time zone tz) = timestamp '2026-08-03 14:00:00');

  -- 2026-08-08 is a Saturday.
  shifted := followup_shift_into_window(timestamptz '2026-08-08 10:00:00-05', tz, 8, 20, weekdays);
  perform pg_temp.check('weekend defers to Monday',
    (shifted at time zone tz) = timestamp '2026-08-10 08:00:00');

  shifted := followup_shift_into_window(timestamptz '2026-08-07 21:00:00-05', tz, 8, 20, weekdays);
  perform pg_temp.check('Friday night defers to Monday',
    (shifted at time zone tz) = timestamp '2026-08-10 08:00:00');

  shifted := followup_shift_into_window(timestamptz '2026-08-03 10:00:00-05', tz, 10.5, 19, days);
  perform pg_temp.check('before 10:30 waits for 10:30',
    (shifted at time zone tz) = timestamp '2026-08-03 10:30:00');

  shifted := followup_shift_into_window(timestamptz '2026-08-03 10:30:00-05', tz, 10.5, 19, days);
  perform pg_temp.check('10:30 on the opening is untouched',
    (shifted at time zone tz) = timestamp '2026-08-03 10:30:00');

  shifted := followup_shift_into_window(timestamptz '2026-08-03 19:00:00-05', tz, 10.5, 19, days);
  perform pg_temp.check('closing hour waits until 10:30 the next day',
    (shifted at time zone tz) = timestamp '2026-08-04 10:30:00');

  perform pg_temp.check('10:15pm is still day when night starts at 10:30pm',
    followup_is_night(timestamptz '2026-08-03 22:15:00-05', tz, 22.5, 8) = false);
  perform pg_temp.check('10:30pm is night when night starts at 10:30pm',
    followup_is_night(timestamptz '2026-08-03 22:30:00-05', tz, 22.5, 8) = true);
  perform pg_temp.check('8:15am is still night when night ends at 8:30am',
    followup_is_night(timestamptz '2026-08-03 08:15:00-05', tz, 21, 8.5) = true);
  perform pg_temp.check('8:30am is day when night ends at 8:30am',
    followup_is_night(timestamptz '2026-08-03 08:30:00-05', tz, 21, 8.5) = false);
end;
$$;

/* ------------------------------------------------------------------ set-up */

delete from followup_messages;
delete from followup_events;
delete from followup_enrollments;
delete from followup_contacts;
delete from followup_steps;
delete from followup_sequences;
delete from followup_operators;
delete from quo_numbers;

insert into followup_operators (slack_user_id, email, display_name, is_supervisor, can_admin)
values ('U0PARALEGAL', 'paralegal@firm.com', 'Paralegal', false, false),
       ('U0OTHERUSER', null, 'Someone else', false, false),
       ('U0SUPERVISOR', 'rosa@firm.com', 'Intake manager', true, true),
       -- The office manager who never touches Slack: email only, no Slack ID.
       (null, 'office@firm.com', 'Office manager', false, true);

insert into quo_numbers (id, phone_e164, label) values
  ('PNINTAKE', '+15125557777', 'Intake line'),
  ('PNSPARE', '+15125558888', 'Spare line');

insert into followup_sequences (slug, name, is_default, quo_number_id, quiet_hours_start, quiet_hours_end)
values ('new-lead', 'New lead follow-up', true, 'PNINTAKE', 0, 24);

insert into followup_steps (sequence_id, position, delay_minutes, body_en, body_es)
select id, 1, 0,
       'Hi {{first_name}}, this is the firm. Do you have a minute?',
       'Hola {{first_name}}, le llamamos del bufete. ¿Tiene un minuto?'
from followup_sequences where slug = 'new-lead';

insert into followup_steps (sequence_id, position, delay_minutes, body_en, body_es)
select id, 2, 60, 'Checking in again, {{first_name}}.', 'Le escribimos de nuevo, {{first_name}}.'
from followup_sequences where slug = 'new-lead';

insert into followup_steps (sequence_id, position, delay_minutes, body_en, body_es)
select id, 3, 120, 'Last note from us, {{first_name}}.', 'Ultimo mensaje, {{first_name}}.'
from followup_sequences where slug = 'new-lead';

/* ------------------------------------------------------------------ enroll */

do $$
declare
  result jsonb;
  claimed jsonb;
  v_enrollment_id uuid;
  v_step_id uuid;
begin
  result := followup_enroll(jsonb_build_object(
    'phone', '(512) 555-0123',
    'language', 'es',
    'first_name', 'Maria',
    'assigned_slack_user_id', 'U0PARALEGAL',
    'assigned_slack_user_name', 'Paralegal',
    'started_by_slack_user_id', 'U0PARALEGAL',
    'slack_channel_id', 'C0INTAKE',
    'slack_thread_ts', '1730000000.000100',
    'source', 'message_action',
    'case_reference', 'MVA-2026-118'
  ));
  perform pg_temp.check('enroll succeeds', (result ->> 'ok')::boolean);
  perform pg_temp.check('phone was normalized', result ->> 'phone' = '+15125550123');
  perform pg_temp.check('language carried through', result ->> 'language' = 'es');
  perform pg_temp.check('three steps counted', (result ->> 'step_count')::int = 3);
  perform pg_temp.check('first send is scheduled', result ->> 'next_run_at' is not null);
  perform pg_temp.check('the Slack thread is remembered',
    result ->> 'slack_thread_ts' = '1730000000.000100');
  perform pg_temp.check('the channel is remembered', result ->> 'slack_channel_id' = 'C0INTAKE');
  v_enrollment_id := (result ->> 'enrollment_id')::uuid;

  perform pg_temp.check('the trigger source is recorded',
    (select source from followup_enrollments where id = v_enrollment_id) = 'message_action');

  -- A second start for the same person is refused rather than double-texting.
  result := followup_enroll(jsonb_build_object(
    'phone', '512-555-0123', 'assigned_slack_user_id', 'U0OTHERUSER'));
  perform pg_temp.check('duplicate enrollment refused', (result ->> 'ok')::boolean is false);
  perform pg_temp.check('duplicate names the reason', result ->> 'reason' = 'already_active');
  perform pg_temp.check('duplicate points at the live series',
    (result ->> 'enrollment_id')::uuid = v_enrollment_id);
  perform pg_temp.check('duplicate points at the existing thread',
    result ->> 'slack_thread_ts' = '1730000000.000100');

  result := followup_enroll(jsonb_build_object('phone', '5125559999'));
  perform pg_temp.check('assignee is required', result ->> 'reason' = 'missing_assignee');

  result := followup_enroll(jsonb_build_object(
    'phone', 'her cell', 'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('bad phone refused', result ->> 'reason' = 'invalid_phone');

  /* --------------------------------------------------------- claim and send */
  select c into claimed from followup_claim_due(10) c limit 1;
  perform pg_temp.check('the due step is claimed', claimed is not null);
  perform pg_temp.check('claim carries Spanish copy', claimed ->> 'body_es' like 'Hola {{first_name}}%');
  perform pg_temp.check('claim carries English copy too', claimed ->> 'body_en' like 'Hi {{first_name}}%');
  perform pg_temp.check('claim is flagged as the first step', (claimed ->> 'is_first_step')::boolean);
  perform pg_temp.check('claim carries the recipient', claimed ->> 'to_number' = '+15125550123');
  perform pg_temp.check('claim carries the sequence Quo number',
    claimed ->> 'quo_number_id' = 'PNINTAKE');
  perform pg_temp.check('claim carries the thread to post into',
    claimed ->> 'slack_thread_ts' = '1730000000.000100');
  v_step_id := (claimed ->> 'step_id')::uuid;

  -- A second claim finds nothing: the row is locked, so two overlapping
  -- dispatcher runs cannot send the same text twice.
  perform pg_temp.check('claimed rows are locked',
    (select count(*) from followup_claim_due(10)) = 0);

  result := followup_record_send(jsonb_build_object(
    'enrollment_id', v_enrollment_id, 'step_id', v_step_id, 'ok', true,
    'body', 'Hola Maria, le llamamos del bufete.', 'segments', 1,
    'quo_message_id', 'MSG-1', 'to_number', '+15125550123', 'from_number', '+15125557777',
    'quo_number_id', 'PNINTAKE'));
  perform pg_temp.check('send is recorded', (result ->> 'ok')::boolean);
  perform pg_temp.check('series is not finished', (result ->> 'completed')::boolean is false);
  perform pg_temp.check('it advanced to step 2', (result ->> 'next_position')::int = 2);
  perform pg_temp.check('segments are stored for cost reporting',
    (select segments from followup_messages where quo_message_id = 'MSG-1') = 1);
  perform pg_temp.check('lock was released',
    (select locked_until is null from followup_enrollments where id = v_enrollment_id));
end;
$$;

/* ---------------------------------------- a paused sequence stops the queue */

do $$
declare
  claimed_count int;
begin
  update followup_sequences set is_active = false where slug = 'new-lead';
  update followup_enrollments set next_run_at = now() - interval '1 minute', locked_until = null
    where status = 'active';
  select count(*) into claimed_count from followup_claim_due(10);
  perform pg_temp.check('switching a sequence off holds its queue', claimed_count = 0);
  update followup_sequences set is_active = true where slug = 'new-lead';
end;
$$;

/* -------------------------------------------- a reply stops the series */

do $$
declare
  result jsonb;
  v_enrollment_id uuid;
begin
  select id into v_enrollment_id from followup_enrollments where status = 'active';

  result := followup_record_inbound(jsonb_build_object(
    'phone', '+15125550123', 'kind', 'message',
    'body', 'Sorry, just seeing this - yes please call me',
    'quo_message_id', 'IN-1', 'is_stop', false, 'is_start', false));

  perform pg_temp.check('inbound recorded', (result ->> 'ok')::boolean);
  perform pg_temp.check('a reply reads as re-engagement', result ->> 'action' = 'reply');
  perform pg_temp.check('the series stopped',
    (select status from followup_enrollments where id = v_enrollment_id) = 'stopped_reply');
  perform pg_temp.check('nothing else is scheduled',
    (select next_run_at is null from followup_enrollments where id = v_enrollment_id));
  perform pg_temp.check('the assigned user is named in the result',
    result ->> 'assigned_slack_user_id' = 'U0PARALEGAL');
  perform pg_temp.check('the reply notification knows its thread',
    result ->> 'slack_thread_ts' = '1730000000.000100');
  perform pg_temp.check('inbound text is logged',
    (select count(*) from followup_messages where direction = 'inbound' and quo_message_id = 'IN-1') = 1);

  -- Quo redelivering the same webhook must not log it twice or re-stop anything.
  result := followup_record_inbound(jsonb_build_object(
    'phone', '+15125550123', 'body', 'Sorry, just seeing this', 'quo_message_id', 'IN-1'));
  perform pg_temp.check('replayed webhook is ignored', (result ->> 'duplicate')::boolean);
  perform pg_temp.check('replay did not double-log',
    (select count(*) from followup_messages where quo_message_id = 'IN-1') = 1);

  perform pg_temp.check('stopped series is not claimed',
    (select count(*) from followup_claim_due(10)) = 0);
end;
$$;

/* ------------------------------------------ an inbound call stops it too */

do $$
declare
  result jsonb;
begin
  result := followup_enroll(jsonb_build_object(
    'phone', '5125550124', 'first_name', 'Carlos', 'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('second client enrolled', (result ->> 'ok')::boolean);

  result := followup_record_inbound(jsonb_build_object('phone', '+15125550124', 'kind', 'call'));
  perform pg_temp.check('a call back reads as re-engagement', result ->> 'action' = 'call');
  perform pg_temp.check('the call stopped the series',
    (select status from followup_enrollments e
     join followup_contacts c on c.id = e.contact_id
     where c.phone_e164 = '+15125550124') = 'stopped_call');
  perform pg_temp.check('a call is not logged as a text',
    (select count(*) from followup_messages m
     join followup_contacts c on c.id = m.contact_id
     where c.phone_e164 = '+15125550124' and m.direction = 'inbound') = 0);
end;
$$;

/* ------------------------------------------------------------ STOP and START */

do $$
declare
  result jsonb;
  v_enrollment_id uuid;
begin
  result := followup_enroll(jsonb_build_object(
    'phone', '5125550125', 'first_name', 'Dana', 'language', 'en',
    'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('third client enrolled', (result ->> 'ok')::boolean);

  result := followup_record_inbound(jsonb_build_object(
    'phone', '+15125550125', 'body', 'STOP', 'quo_message_id', 'IN-STOP', 'is_stop', true));
  perform pg_temp.check('STOP opts the contact out', result ->> 'action' = 'opt_out');
  perform pg_temp.check('opt-out is stored on the contact',
    (select opted_out_at is not null from followup_contacts where phone_e164 = '+15125550125'));
  perform pg_temp.check('STOP also stops the series',
    (select status from followup_enrollments e
     join followup_contacts c on c.id = e.contact_id
     where c.phone_e164 = '+15125550125') = 'stopped_opt_out');

  -- Opting out is sticky: a new start is refused until they opt back in.
  result := followup_enroll(jsonb_build_object(
    'phone', '5125550125', 'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('opted-out contact cannot be re-enrolled', result ->> 'reason' = 'opted_out');

  result := followup_record_inbound(jsonb_build_object(
    'phone', '+15125550125', 'body', 'START', 'quo_message_id', 'IN-START', 'is_start', true));
  perform pg_temp.check('START opts back in', result ->> 'action' = 'opt_in');
  perform pg_temp.check('opt-out cleared',
    (select opted_out_at is null from followup_contacts where phone_e164 = '+15125550125'));

  result := followup_enroll(jsonb_build_object(
    'phone', '5125550125', 'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('re-enrollment works after opting back in', (result ->> 'ok')::boolean);
  v_enrollment_id := (result ->> 'enrollment_id')::uuid;

  -- A client answering "start" or "yes" to a live series is replying, not
  -- subscribing. That has to stop the series, not quietly do nothing.
  result := followup_record_inbound(jsonb_build_object(
    'phone', '+15125550125', 'body', 'yes', 'quo_message_id', 'IN-YES', 'is_start', true));
  perform pg_temp.check('START on a live series counts as a reply', result ->> 'action' = 'reply');
  perform pg_temp.check('and it stops the series',
    (select status from followup_enrollments where id = v_enrollment_id) = 'stopped_reply');
  perform pg_temp.check('and it does not touch the opt-out state',
    (select opted_out_at is null from followup_contacts where phone_e164 = '+15125550125'));
end;
$$;

/* ------------------------------------------------ who is allowed to stop it */

do $$
declare
  result jsonb;
  v_enrollment_id uuid;
begin
  result := followup_enroll(jsonb_build_object(
    'phone', '5125550130', 'first_name', 'Ruth', 'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('a series to test permissions against', (result ->> 'ok')::boolean);
  v_enrollment_id := (result ->> 'enrollment_id')::uuid;

  result := followup_stop(jsonb_build_object(
    'enrollment_id', v_enrollment_id, 'reason', 'manual',
    'actor', 'U0OTHERUSER', 'enforce_assignment', true));
  perform pg_temp.check('an unassigned operator cannot stop it', result ->> 'reason' = 'not_assigned');
  perform pg_temp.check('the refusal says who owns it',
    result ->> 'assigned_slack_user_id' = 'U0PARALEGAL');
  perform pg_temp.check('the series is still running',
    (select status from followup_enrollments where id = v_enrollment_id) = 'active');

  result := followup_stop(jsonb_build_object(
    'enrollment_id', v_enrollment_id, 'reason', 'manual',
    'actor', 'U0SUPERVISOR', 'enforce_assignment', true));
  perform pg_temp.check('a supervisor can stop it', (result ->> 'ok')::boolean);
  perform pg_temp.check('it is marked as a manual stop',
    (select status from followup_enrollments where id = v_enrollment_id) = 'stopped_manual');
  perform pg_temp.check('the stop is attributed',
    (select ended_by from followup_enrollments where id = v_enrollment_id) = 'U0SUPERVISOR');

  result := followup_stop(jsonb_build_object(
    'enrollment_id', v_enrollment_id, 'reason', 'manual', 'actor', 'U0PARALEGAL'));
  perform pg_temp.check('stopping twice is refused cleanly', result ->> 'reason' = 'not_active');
end;
$$;

/* ----------------------------------- the assigned user can stop by phone */

do $$
declare
  result jsonb;
begin
  result := followup_enroll(jsonb_build_object(
    'phone', '5125550126', 'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('fourth client enrolled', (result ->> 'ok')::boolean);

  result := followup_stop(jsonb_build_object(
    'phone', '(512) 555-0126', 'reason', 'manual',
    'actor', 'U0PARALEGAL', 'enforce_assignment', true));
  perform pg_temp.check('the assigned user can stop by phone number', (result ->> 'ok')::boolean);
  perform pg_temp.check('the stop reports how many texts went out',
    (result ->> 'sent_count')::int = 0);

  result := followup_stop(jsonb_build_object(
    'phone', '5125559999', 'reason', 'manual', 'actor', 'U0PARALEGAL'));
  perform pg_temp.check('stopping an unknown number is refused cleanly',
    result ->> 'reason' = 'no_active_enrollment');
end;
$$;

/* ------------------------------------------------------------ send failures */

do $$
declare
  result jsonb;
  v_enrollment_id uuid;
  v_step_id uuid;
  claimed jsonb;
begin
  -- The retry budget is a setting, so prove the setting is what drives it.
  update app_settings set value = '2'::jsonb where key = 'max_send_attempts';

  result := followup_enroll(jsonb_build_object(
    'phone', '5125550127', 'assigned_slack_user_id', 'U0PARALEGAL'));
  v_enrollment_id := (result ->> 'enrollment_id')::uuid;
  select c into claimed from followup_claim_due(10) c limit 1;
  v_step_id := (claimed ->> 'step_id')::uuid;

  result := followup_record_send(jsonb_build_object(
    'enrollment_id', v_enrollment_id, 'step_id', v_step_id, 'ok', false,
    'body', 'x', 'error', 'Quo returned 400'));
  perform pg_temp.check('first failure schedules a retry', (result ->> 'final')::boolean is false);
  perform pg_temp.check('retry is in the future', (result ->> 'retry_at')::timestamptz > now());

  result := followup_record_send(jsonb_build_object(
    'enrollment_id', v_enrollment_id, 'step_id', v_step_id, 'ok', false,
    'body', 'x', 'error', 'Quo returned 400'));
  perform pg_temp.check('the second failure gives up, because the setting says two',
    (result ->> 'final')::boolean);
  perform pg_temp.check('the series is marked failed',
    (select status from followup_enrollments where id = v_enrollment_id) = 'failed');

  update app_settings set value = '3'::jsonb where key = 'max_send_attempts';
end;
$$;

/* --------------------------------------------------- running out of steps */

do $$
declare
  result jsonb;
  v_enrollment_id uuid;
  claimed jsonb;
  step_number int := 0;
begin
  result := followup_enroll(jsonb_build_object(
    'phone', '5125550128', 'assigned_slack_user_id', 'U0PARALEGAL'));
  v_enrollment_id := (result ->> 'enrollment_id')::uuid;

  -- Walk all three steps, pulling each one forward so the test does not have to
  -- wait out the real delays.
  for step_number in 1..3 loop
    update followup_enrollments
      set next_run_at = now() - interval '1 minute', locked_until = null
      where id = v_enrollment_id;
    select c into claimed from followup_claim_due(10) c
      where (c ->> 'enrollment_id')::uuid = v_enrollment_id limit 1;
    perform pg_temp.check(format('step %s is claimable', step_number), claimed is not null);
    perform pg_temp.check(format('step %s is only the first once', step_number),
      ((claimed ->> 'is_first_step')::boolean) = (step_number = 1));

    result := followup_record_send(jsonb_build_object(
      'enrollment_id', v_enrollment_id, 'step_id', claimed ->> 'step_id', 'ok', true,
      'body', 'sent', 'segments', 1, 'quo_message_id', 'OUT-' || step_number));
    perform pg_temp.check(format('step %s sends', step_number), (result ->> 'ok')::boolean);
  end loop;

  perform pg_temp.check('the series completes after the last step', (result ->> 'completed')::boolean);
  perform pg_temp.check('status is completed',
    (select status from followup_enrollments where id = v_enrollment_id) = 'completed');
  perform pg_temp.check('a completed series is never claimed again',
    (select count(*) from followup_claim_due(10)) = 0);
end;
$$;

/* --------------------------------------------------------- delivery receipts */

do $$
declare
  result jsonb;
begin
  result := followup_record_delivery(jsonb_build_object('quo_message_id', 'OUT-1', 'status', 'delivered'));
  perform pg_temp.check('delivery receipt applies', (result ->> 'ok')::boolean);
  perform pg_temp.check('message shows delivered',
    (select status from followup_messages where quo_message_id = 'OUT-1') = 'delivered');

  result := followup_record_delivery(jsonb_build_object(
    'quo_message_id', 'OUT-2', 'status', 'undelivered', 'error', 'Landline'));
  perform pg_temp.check('a hard bounce applies', (result ->> 'ok')::boolean);
  perform pg_temp.check('a hard bounce is logged as an event',
    (select count(*) from followup_events where kind = 'delivery_failed') = 1);

  result := followup_record_delivery(jsonb_build_object(
    'quo_message_id', 'NOT-A-REAL-ID', 'status', 'delivered'));
  perform pg_temp.check('an unknown message id is refused cleanly',
    result ->> 'reason' = 'message_not_found');
end;
$$;

/* ---------------------------------------------------- sequences with no steps */

do $$
declare
  result jsonb;
  empty_id uuid;
begin
  insert into followup_sequences (slug, name, is_active)
  values ('empty', 'Empty sequence', true) returning id into empty_id;

  result := followup_enroll(jsonb_build_object(
    'phone', '5125550129', 'sequence_slug', 'empty', 'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('an empty sequence cannot be started', result ->> 'reason' = 'no_steps');

  update followup_sequences set is_active = false where id = empty_id;
  insert into followup_steps (sequence_id, position, body_en, body_es) values (empty_id, 1, 'en', 'es');

  result := followup_enroll(jsonb_build_object(
    'phone', '5125550129', 'sequence_slug', 'empty', 'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('a switched-off sequence cannot be started',
    result ->> 'reason' = 'sequence_inactive');

  result := followup_enroll(jsonb_build_object(
    'phone', '5125550129', 'sequence_slug', 'no-such-sequence',
    'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('an unknown sequence is refused', result ->> 'reason' = 'sequence_not_found');
end;
$$;

/* ------------------------------------------------------------ default number */

do $$
declare
  claimed jsonb;
  seq_id uuid;
  v_enrollment_id uuid;
  result jsonb;
begin
  -- A sequence with no number of its own falls back to the default in settings.
  select id into seq_id from followup_sequences where slug = 'new-lead';
  update followup_sequences set quo_number_id = null where id = seq_id;
  update app_settings set value = '"PNSPARE"'::jsonb where key = 'default_quo_number_id';

  result := followup_enroll(jsonb_build_object(
    'phone', '5125550131', 'assigned_slack_user_id', 'U0PARALEGAL'));
  v_enrollment_id := (result ->> 'enrollment_id')::uuid;

  select c into claimed from followup_claim_due(10) c
    where (c ->> 'enrollment_id')::uuid = v_enrollment_id limit 1;
  perform pg_temp.check('a sequence with no number falls back to the default',
    claimed ->> 'quo_number_id' = 'PNSPARE');

  update followup_sequences set quo_number_id = 'PNINTAKE' where id = seq_id;
  perform followup_stop(jsonb_build_object('enrollment_id', v_enrollment_id, 'reason', 'manual'));
end;
$$;

do $$
declare
  claimed jsonb;
  v_enrollment_id uuid;
  result jsonb;
begin
  -- A start that names a sending number uses that line, even when the sequence
  -- has one of its own.
  result := followup_enroll(jsonb_build_object(
    'phone', '5125550132', 'assigned_slack_user_id', 'U0PARALEGAL',
    'quo_number_id', 'PNSPARE'));
  v_enrollment_id := (result ->> 'enrollment_id')::uuid;
  perform pg_temp.check('a start can name a sending number', result ->> 'quo_number_id' = 'PNSPARE');

  select c into claimed from followup_claim_due(10) c
    where (c ->> 'enrollment_id')::uuid = v_enrollment_id limit 1;
  perform pg_temp.check('that named number is what actually sends',
    claimed ->> 'quo_number_id' = 'PNSPARE');

  perform followup_stop(jsonb_build_object('enrollment_id', v_enrollment_id, 'reason', 'manual'));

  result := followup_enroll(jsonb_build_object(
    'phone', '5125550133', 'assigned_slack_user_id', 'U0PARALEGAL',
    'quo_number_id', 'PNNOPE'));
  perform pg_temp.check('an unknown sending number is refused', result ->> 'reason' = 'unknown_quo_number');
end;
$$;

/* ----------------------------------------------------------------- settings */

do $$
begin
  perform pg_temp.check('a missing setting falls back', setting_int('not_a_real_key', 7) = 7);
  perform pg_temp.check('an integer setting reads back',
    setting_int('dispatch_batch_size', 999) = 25);
  perform pg_temp.check('a boolean setting reads back',
    setting_bool('send_stop_confirmation', false) = true);
end;
$$;

/* ------------------------------------------------------------ access list */

do $$
declare
  failed boolean;
begin
  perform pg_temp.check('somebody can exist with an email and no Slack ID',
    (select count(*) from followup_operators
     where slack_user_id is null and email = 'office@firm.com') = 1);

  perform pg_temp.check('somebody can exist with a Slack ID and no email',
    (select count(*) from followup_operators
     where slack_user_id = 'U0OTHERUSER' and email is null) = 1);

  -- A row with neither identity is nobody, and would be unreachable by either
  -- sign-in path.
  failed := false;
  begin
    insert into followup_operators (display_name) values ('Nobody');
  exception when check_violation then failed := true;
  end;
  perform pg_temp.check('a person with no identity at all is rejected', failed);

  -- Emails are compared case-insensitively, so storing a mixed-case one would
  -- quietly lock somebody out.
  failed := false;
  begin
    insert into followup_operators (email) values ('Mixed@Firm.com');
  exception when check_violation then failed := true;
  end;
  perform pg_temp.check('a mixed-case email is rejected', failed);

  failed := false;
  begin
    insert into followup_operators (email) values ('not-an-email');
  exception when check_violation then failed := true;
  end;
  perform pg_temp.check('a malformed email is rejected', failed);

  failed := false;
  begin
    insert into followup_operators (email) values ('office@firm.com');
  exception when unique_violation then failed := true;
  end;
  perform pg_temp.check('the same email cannot be added twice', failed);

  failed := false;
  begin
    insert into followup_operators (slack_user_id) values ('U0PARALEGAL');
  exception when unique_violation then failed := true;
  end;
  perform pg_temp.check('the same Slack ID cannot be added twice', failed);

  failed := false;
  begin
    insert into followup_operators (slack_user_id, email) values ('lower-case', 'x@firm.com');
  exception when check_violation then failed := true;
  end;
  perform pg_temp.check('a malformed Slack ID is still rejected', failed);
end;
$$;

do $$
declare
  v_session text := 'test-session-1';
  v_person uuid;
begin
  select id into v_person from followup_operators where email = 'office@firm.com';

  insert into app_sessions (id, user_id, provider, email, expires_at)
  values (v_session, v_person, 'google', 'office@firm.com', now() + interval '1 day');

  perform pg_temp.check('a Google session hangs off the person, not a copy of their rights',
    (select user_id from app_sessions where id = v_session) = v_person);

  -- Deleting somebody must not leave their session behind.
  delete from followup_operators where id = v_person;
  perform pg_temp.check('removing somebody drops their sessions with them',
    (select count(*) from app_sessions where id = v_session) = 0);

  insert into followup_operators (email, display_name, can_admin)
  values ('office@firm.com', 'Office manager', true);
end;
$$;

/* -------------------------------------------------------------- audit trail */

do $$
begin
  perform pg_temp.check('enrollments are logged',
    (select count(*) from followup_events where kind = 'enrolled') >= 6);
  perform pg_temp.check('stops are logged',
    (select count(*) from followup_events where kind like 'status_stopped%') >= 5);
  perform pg_temp.check('completion is logged',
    (select count(*) from followup_events where kind = 'status_completed') = 1);
end;
$$;

do $$ begin raise notice 'ALL TESTS PASSED'; end; $$;
