-- Exercises the follow-up state machine end to end.
--
-- Run against a scratch database that already has the two migrations applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/followups_test.sql
--
-- Every check raises on failure, so a clean run that prints ALL TESTS PASSED is
-- the whole result. It writes real rows, so point it at a scratch database.

\set ON_ERROR_STOP on

create or replace function pg_temp.check(label text, condition boolean)
returns void language plpgsql as $$
begin
  if condition is not true then
    raise exception 'FAILED: %', label;
  end if;
  raise notice 'ok  %', label;
end;
$$;

-- ------------------------------------------------------------ phone parsing

do $$
begin
  perform pg_temp.check('ten digits get +1',
    public.followup_normalize_phone('5125550123') = '+15125550123');
  perform pg_temp.check('formatted US number',
    public.followup_normalize_phone('(512) 555-0123') = '+15125550123');
  perform pg_temp.check('leading 1',
    public.followup_normalize_phone('1-512-555-0123') = '+15125550123');
  perform pg_temp.check('already E.164',
    public.followup_normalize_phone('+15125550123') = '+15125550123');
  perform pg_temp.check('spaces in E.164',
    public.followup_normalize_phone('+1 512 555 0123') = '+15125550123');
  perform pg_temp.check('garbage is rejected',
    public.followup_normalize_phone('call me') is null);
  perform pg_temp.check('too short is rejected',
    public.followup_normalize_phone('5550123') is null);
end;
$$;

-- -------------------------------------------------------------- quiet hours

do $$
declare
  tz text := 'America/Chicago';
  days smallint[] := array[1,2,3,4,5,6,7]::smallint[];
  weekdays smallint[] := array[1,2,3,4,5]::smallint[];
  shifted timestamptz;
begin
  -- 2:30am local moves to 8:00am the same morning.
  shifted := public.followup_shift_into_window(
    timestamptz '2026-08-03 02:30:00-05', tz, 8, 20, days);
  perform pg_temp.check('pre-dawn moves to 8am',
    (shifted at time zone tz) = timestamp '2026-08-03 08:00:00');

  -- 10:15pm local moves to 8:00am the next morning.
  shifted := public.followup_shift_into_window(
    timestamptz '2026-08-03 22:15:00-05', tz, 8, 20, days);
  perform pg_temp.check('late night moves to next morning',
    (shifted at time zone tz) = timestamp '2026-08-04 08:00:00');

  -- Inside the window it is left alone.
  shifted := public.followup_shift_into_window(
    timestamptz '2026-08-03 14:00:00-05', tz, 8, 20, days);
  perform pg_temp.check('mid-afternoon is untouched',
    (shifted at time zone tz) = timestamp '2026-08-03 14:00:00');

  -- Saturday with a weekdays-only sequence lands Monday morning.
  -- 2026-08-08 is a Saturday.
  shifted := public.followup_shift_into_window(
    timestamptz '2026-08-08 10:00:00-05', tz, 8, 20, weekdays);
  perform pg_temp.check('weekend defers to Monday',
    (shifted at time zone tz) = timestamp '2026-08-10 08:00:00');

  -- Friday 9pm with weekdays-only also lands Monday morning.
  shifted := public.followup_shift_into_window(
    timestamptz '2026-08-07 21:00:00-05', tz, 8, 20, weekdays);
  perform pg_temp.check('friday night defers to Monday',
    (shifted at time zone tz) = timestamp '2026-08-10 08:00:00');
end;
$$;

-- --------------------------------------------------------------- fixtures

delete from public.followup_messages;
delete from public.followup_events;
delete from public.followup_enrollments;
delete from public.followup_contacts;
delete from public.followup_steps;
delete from public.followup_sequences;
delete from public.followup_operators;

insert into public.followup_operators (slack_user_id, display_name, is_supervisor)
values ('U0PARALEGAL', 'Paralegal', false),
       ('U0OTHERUSER', 'Someone else', false),
       ('U0SUPERVISOR', 'Intake manager', true);

insert into public.followup_sequences (slug, name, is_default, quiet_hours_start, quiet_hours_end)
values ('new-lead', 'New lead follow-up', true, 0, 24);

insert into public.followup_steps (sequence_id, position, delay_minutes, body_en, body_es)
select id, 1, 0,
       'Hi {{first_name}}, this is the firm. Do you have a minute?',
       'Hola {{first_name}}, le llamamos del bufete. ¿Tiene un minuto?'
from public.followup_sequences where slug = 'new-lead';

insert into public.followup_steps (sequence_id, position, delay_minutes, body_en, body_es)
select id, 2, 60, 'Checking in again, {{first_name}}.', 'Le escribimos de nuevo, {{first_name}}.'
from public.followup_sequences where slug = 'new-lead';

insert into public.followup_steps (sequence_id, position, delay_minutes, body_en, body_es)
select id, 3, 120, 'Last note from us, {{first_name}}.', 'Último mensaje, {{first_name}}.'
from public.followup_sequences where slug = 'new-lead';

-- ------------------------------------------------------------------ enroll

do $$
declare
  result jsonb;
  claimed jsonb;
  v_enrollment_id uuid;
  v_step_id uuid;
begin
  result := public.followup_enroll(jsonb_build_object(
    'phone', '(512) 555-0123',
    'language', 'es',
    'first_name', 'Maria',
    'assigned_slack_user_id', 'U0PARALEGAL',
    'assigned_slack_user_name', 'Paralegal',
    'started_by_slack_user_id', 'U0PARALEGAL',
    'slack_channel_id', 'C0INTAKE',
    'case_reference', 'MVA-2026-118'
  ));
  perform pg_temp.check('enroll succeeds', (result ->> 'ok')::boolean);
  perform pg_temp.check('phone was normalized', result ->> 'phone' = '+15125550123');
  perform pg_temp.check('language carried through', result ->> 'language' = 'es');
  perform pg_temp.check('three steps counted', (result ->> 'step_count')::int = 3);
  perform pg_temp.check('first send is scheduled', result ->> 'next_run_at' is not null);
  v_enrollment_id := (result ->> 'enrollment_id')::uuid;

  -- A second start for the same person is refused rather than double-texting.
  result := public.followup_enroll(jsonb_build_object(
    'phone', '512-555-0123', 'assigned_slack_user_id', 'U0OTHERUSER'));
  perform pg_temp.check('duplicate enrollment refused', (result ->> 'ok')::boolean is false);
  perform pg_temp.check('duplicate names the reason', result ->> 'reason' = 'already_active');
  perform pg_temp.check('duplicate points at the live series',
    (result ->> 'enrollment_id')::uuid = v_enrollment_id);

  -- Missing assignee is refused: there is always somebody on the hook.
  result := public.followup_enroll(jsonb_build_object('phone', '5125559999'));
  perform pg_temp.check('assignee is required', result ->> 'reason' = 'missing_assignee');

  -- Unreadable phone number is refused before a contact row is created.
  result := public.followup_enroll(jsonb_build_object(
    'phone', 'her cell', 'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('bad phone refused', result ->> 'reason' = 'invalid_phone');

  -- ------------------------------------------------------------ claim + send
  select c into claimed from public.followup_claim_due(10) c limit 1;
  perform pg_temp.check('the due step is claimed', claimed is not null);
  perform pg_temp.check('claim carries Spanish copy',
    claimed ->> 'body_es' like 'Hola {{first_name}}%');
  perform pg_temp.check('claim carries English copy too',
    claimed ->> 'body_en' like 'Hi {{first_name}}%');
  perform pg_temp.check('claim is flagged as the first step',
    (claimed ->> 'is_first_step')::boolean);
  perform pg_temp.check('claim carries the recipient',
    claimed ->> 'to_number' = '+15125550123');
  v_step_id := (claimed ->> 'step_id')::uuid;

  -- A second claim finds nothing: the row is locked for five minutes, so two
  -- overlapping cron runs cannot send the same text twice.
  perform pg_temp.check('claimed rows are locked',
    (select count(*) from public.followup_claim_due(10)) = 0);

  result := public.followup_record_send(jsonb_build_object(
    'enrollment_id', v_enrollment_id, 'step_id', v_step_id, 'ok', true,
    'body', 'Hola Maria, le llamamos del bufete.',
    'quo_message_id', 'MSG-1', 'to_number', '+15125550123', 'from_number', '+15125557777'));
  perform pg_temp.check('send is recorded', (result ->> 'ok')::boolean);
  perform pg_temp.check('series is not finished', (result ->> 'completed')::boolean is false);
  perform pg_temp.check('it advanced to step 2', (result ->> 'next_position')::int = 2);

  perform pg_temp.check('outbound text is logged',
    (select count(*) from public.followup_messages
     where enrollment_id = v_enrollment_id and direction = 'outbound' and status = 'sent') = 1);
  perform pg_temp.check('lock was released',
    (select locked_until is null from public.followup_enrollments where id = v_enrollment_id));
end;
$$;

-- ------------------------------------------------- a reply stops the series

do $$
declare
  result jsonb;
  v_enrollment_id uuid;
begin
  select id into v_enrollment_id from public.followup_enrollments where status = 'active';

  result := public.followup_record_inbound(jsonb_build_object(
    'phone', '+15125550123', 'kind', 'message',
    'body', 'Sorry, just seeing this - yes please call me',
    'quo_message_id', 'IN-1', 'is_stop', false, 'is_start', false));

  perform pg_temp.check('inbound recorded', (result ->> 'ok')::boolean);
  perform pg_temp.check('a reply reads as re-engagement', result ->> 'action' = 'reply');
  perform pg_temp.check('the series stopped',
    (select status from public.followup_enrollments where id = v_enrollment_id) = 'stopped_reply');
  perform pg_temp.check('nothing else is scheduled',
    (select next_run_at is null from public.followup_enrollments where id = v_enrollment_id));
  perform pg_temp.check('the assigned user is named in the result',
    result ->> 'assigned_slack_user_id' = 'U0PARALEGAL');
  perform pg_temp.check('inbound text is logged',
    (select count(*) from public.followup_messages
     where direction = 'inbound' and quo_message_id = 'IN-1') = 1);

  -- Quo redelivering the same webhook must not log it twice or re-stop anything.
  result := public.followup_record_inbound(jsonb_build_object(
    'phone', '+15125550123', 'body', 'Sorry, just seeing this', 'quo_message_id', 'IN-1'));
  perform pg_temp.check('replayed webhook is ignored', (result ->> 'duplicate')::boolean);
  perform pg_temp.check('replay did not double-log',
    (select count(*) from public.followup_messages where quo_message_id = 'IN-1') = 1);

  -- Nothing is due now that the only series has stopped.
  perform pg_temp.check('stopped series is not claimed',
    (select count(*) from public.followup_claim_due(10)) = 0);
end;
$$;

-- ---------------------------------------------- an inbound call stops it too

do $$
declare
  result jsonb;
begin
  result := public.followup_enroll(jsonb_build_object(
    'phone', '5125550124', 'first_name', 'Carlos',
    'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('second client enrolled', (result ->> 'ok')::boolean);

  result := public.followup_record_inbound(jsonb_build_object(
    'phone', '+15125550124', 'kind', 'call'));
  perform pg_temp.check('a call back reads as re-engagement', result ->> 'action' = 'call');
  perform pg_temp.check('the call stopped the series',
    (select status from public.followup_enrollments e
     join public.followup_contacts c on c.id = e.contact_id
     where c.phone_e164 = '+15125550124') = 'stopped_call');
  perform pg_temp.check('a call is not logged as a text',
    (select count(*) from public.followup_messages m
     join public.followup_contacts c on c.id = m.contact_id
     where c.phone_e164 = '+15125550124' and m.direction = 'inbound') = 0);
end;
$$;

-- ---------------------------------------------------------- STOP and START

do $$
declare
  result jsonb;
  v_enrollment_id uuid;
begin
  result := public.followup_enroll(jsonb_build_object(
    'phone', '5125550125', 'first_name', 'Dana', 'language', 'en',
    'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('third client enrolled', (result ->> 'ok')::boolean);

  result := public.followup_record_inbound(jsonb_build_object(
    'phone', '+15125550125', 'body', 'STOP', 'quo_message_id', 'IN-STOP',
    'is_stop', true));
  perform pg_temp.check('STOP opts the contact out', result ->> 'action' = 'opt_out');
  perform pg_temp.check('opt-out is stored on the contact',
    (select opted_out_at is not null from public.followup_contacts
     where phone_e164 = '+15125550125'));
  perform pg_temp.check('STOP also stops the series',
    (select status from public.followup_enrollments e
     join public.followup_contacts c on c.id = e.contact_id
     where c.phone_e164 = '+15125550125') = 'stopped_opt_out');

  -- Opting out is sticky: a new start is refused until they opt back in.
  result := public.followup_enroll(jsonb_build_object(
    'phone', '5125550125', 'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('opted-out contact cannot be re-enrolled',
    result ->> 'reason' = 'opted_out');

  result := public.followup_record_inbound(jsonb_build_object(
    'phone', '+15125550125', 'body', 'START', 'quo_message_id', 'IN-START',
    'is_start', true));
  perform pg_temp.check('START opts back in', result ->> 'action' = 'opt_in');
  perform pg_temp.check('opt-out cleared',
    (select opted_out_at is null from public.followup_contacts
     where phone_e164 = '+15125550125'));

  result := public.followup_enroll(jsonb_build_object(
    'phone', '5125550125', 'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('re-enrollment works after opting back in',
    (result ->> 'ok')::boolean);
  v_enrollment_id := (result ->> 'enrollment_id')::uuid;

  -- A client answering "start" or "yes" to a live series is replying, not
  -- subscribing. That has to stop the series, not quietly do nothing.
  result := public.followup_record_inbound(jsonb_build_object(
    'phone', '+15125550125', 'body', 'yes', 'quo_message_id', 'IN-YES',
    'is_start', true));
  perform pg_temp.check('START on a live series counts as a reply',
    result ->> 'action' = 'reply');
  perform pg_temp.check('and it stops the series',
    (select status from public.followup_enrollments
     where id = v_enrollment_id) = 'stopped_reply');
  perform pg_temp.check('and it does not touch the opt-out state',
    (select opted_out_at is null from public.followup_contacts
     where phone_e164 = '+15125550125'));
end;
$$;

-- ------------------------------------------------- who is allowed to stop it

do $$
declare
  result jsonb;
  v_enrollment_id uuid;
begin
  result := public.followup_enroll(jsonb_build_object(
    'phone', '5125550130', 'first_name', 'Ruth',
    'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('a series to test permissions against', (result ->> 'ok')::boolean);
  v_enrollment_id := (result ->> 'enrollment_id')::uuid;

  -- Someone who is not the assigned user is refused.
  result := public.followup_stop(jsonb_build_object(
    'enrollment_id', v_enrollment_id, 'reason', 'manual',
    'actor', 'U0OTHERUSER', 'enforce_assignment', true));
  perform pg_temp.check('an unassigned operator cannot stop it',
    result ->> 'reason' = 'not_assigned');
  perform pg_temp.check('the refusal says who owns it',
    result ->> 'assigned_slack_user_id' = 'U0PARALEGAL');
  perform pg_temp.check('the series is still running',
    (select status from public.followup_enrollments where id = v_enrollment_id) = 'active');

  -- A supervisor can override.
  result := public.followup_stop(jsonb_build_object(
    'enrollment_id', v_enrollment_id, 'reason', 'manual',
    'actor', 'U0SUPERVISOR', 'enforce_assignment', true));
  perform pg_temp.check('a supervisor can stop it', (result ->> 'ok')::boolean);
  perform pg_temp.check('it is marked as a manual stop',
    (select status from public.followup_enrollments where id = v_enrollment_id) = 'stopped_manual');
  perform pg_temp.check('the stop is attributed',
    (select ended_by from public.followup_enrollments where id = v_enrollment_id) = 'U0SUPERVISOR');

  -- Stopping something already stopped is a no-op, not an error.
  result := public.followup_stop(jsonb_build_object(
    'enrollment_id', v_enrollment_id, 'reason', 'manual', 'actor', 'U0PARALEGAL'));
  perform pg_temp.check('stopping twice is refused cleanly',
    result ->> 'reason' = 'not_active');
end;
$$;

-- ------------------------------------------ the assigned user can stop by phone

do $$
declare
  result jsonb;
begin
  result := public.followup_enroll(jsonb_build_object(
    'phone', '5125550126', 'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('fourth client enrolled', (result ->> 'ok')::boolean);

  result := public.followup_stop(jsonb_build_object(
    'phone', '(512) 555-0126', 'reason', 'manual',
    'actor', 'U0PARALEGAL', 'enforce_assignment', true));
  perform pg_temp.check('the assigned user can stop by phone number',
    (result ->> 'ok')::boolean);
  perform pg_temp.check('the stop reports how many texts went out',
    (result ->> 'sent_count')::int = 0);

  result := public.followup_stop(jsonb_build_object(
    'phone', '5125559999', 'reason', 'manual', 'actor', 'U0PARALEGAL'));
  perform pg_temp.check('stopping an unknown number is refused cleanly',
    result ->> 'reason' = 'no_active_enrollment');
end;
$$;

-- --------------------------------------------------------- send failures

do $$
declare
  result jsonb;
  v_enrollment_id uuid;
  v_step_id uuid;
  claimed jsonb;
begin
  result := public.followup_enroll(jsonb_build_object(
    'phone', '5125550127', 'assigned_slack_user_id', 'U0PARALEGAL'));
  v_enrollment_id := (result ->> 'enrollment_id')::uuid;
  select c into claimed from public.followup_claim_due(10) c limit 1;
  v_step_id := (claimed ->> 'step_id')::uuid;

  -- Two failures retry, the third parks the series so a landline does not get
  -- retried forever.
  result := public.followup_record_send(jsonb_build_object(
    'enrollment_id', v_enrollment_id, 'step_id', v_step_id, 'ok', false,
    'body', 'x', 'error', 'Quo returned 400'));
  perform pg_temp.check('first failure schedules a retry',
    (result ->> 'final')::boolean is false);
  perform pg_temp.check('retry is in the future', (result ->> 'retry_at')::timestamptz > now());

  result := public.followup_record_send(jsonb_build_object(
    'enrollment_id', v_enrollment_id, 'step_id', v_step_id, 'ok', false,
    'body', 'x', 'error', 'Quo returned 400'));
  perform pg_temp.check('second failure still retries',
    (result ->> 'final')::boolean is false);

  result := public.followup_record_send(jsonb_build_object(
    'enrollment_id', v_enrollment_id, 'step_id', v_step_id, 'ok', false,
    'body', 'x', 'error', 'Quo returned 400'));
  perform pg_temp.check('third failure gives up', (result ->> 'final')::boolean);
  perform pg_temp.check('the series is marked failed',
    (select status from public.followup_enrollments where id = v_enrollment_id) = 'failed');
  perform pg_temp.check('failed sends are all logged',
    (select count(*) from public.followup_messages
     where enrollment_id = v_enrollment_id and status = 'failed') = 3);
end;
$$;

-- -------------------------------------------------- running out of steps

do $$
declare
  result jsonb;
  v_enrollment_id uuid;
  claimed jsonb;
  position int := 0;
begin
  result := public.followup_enroll(jsonb_build_object(
    'phone', '5125550128', 'assigned_slack_user_id', 'U0PARALEGAL'));
  v_enrollment_id := (result ->> 'enrollment_id')::uuid;

  -- Walk all three steps. Each one is pulled forward so the test does not have
  -- to wait out the real delays.
  for position in 1..3 loop
    update public.followup_enrollments
      set next_run_at = now() - interval '1 minute', locked_until = null
      where id = v_enrollment_id;
    select c into claimed from public.followup_claim_due(10) c
      where (c ->> 'enrollment_id')::uuid = v_enrollment_id limit 1;
    perform pg_temp.check(format('step %s is claimable', position), claimed is not null);
    perform pg_temp.check(format('step %s is only the first once', position),
      ((claimed ->> 'is_first_step')::boolean) = (position = 1));

    result := public.followup_record_send(jsonb_build_object(
      'enrollment_id', v_enrollment_id, 'step_id', claimed ->> 'step_id', 'ok', true,
      'body', 'sent', 'quo_message_id', 'OUT-' || position));
    perform pg_temp.check(format('step %s sends', position), (result ->> 'ok')::boolean);
  end loop;

  perform pg_temp.check('the series completes after the last step',
    (result ->> 'completed')::boolean);
  perform pg_temp.check('status is completed',
    (select status from public.followup_enrollments where id = v_enrollment_id) = 'completed');
  perform pg_temp.check('a completed series is never claimed again',
    (select count(*) from public.followup_claim_due(10)) = 0);
end;
$$;

-- ------------------------------------------------------- delivery receipts

do $$
declare
  result jsonb;
begin
  result := public.followup_record_delivery(jsonb_build_object(
    'quo_message_id', 'OUT-1', 'status', 'delivered'));
  perform pg_temp.check('delivery receipt applies', (result ->> 'ok')::boolean);
  perform pg_temp.check('message shows delivered',
    (select status from public.followup_messages where quo_message_id = 'OUT-1') = 'delivered');

  result := public.followup_record_delivery(jsonb_build_object(
    'quo_message_id', 'OUT-2', 'status', 'undelivered', 'error', 'Landline'));
  perform pg_temp.check('a hard bounce applies', (result ->> 'ok')::boolean);
  perform pg_temp.check('a hard bounce is logged as an event',
    (select count(*) from public.followup_events where kind = 'delivery_failed') = 1);

  result := public.followup_record_delivery(jsonb_build_object(
    'quo_message_id', 'NOT-A-REAL-ID', 'status', 'delivered'));
  perform pg_temp.check('an unknown message id is refused cleanly',
    result ->> 'reason' = 'message_not_found');
end;
$$;

-- ------------------------------------------------- sequences with no steps

do $$
declare
  result jsonb;
  empty_id uuid;
begin
  insert into public.followup_sequences (slug, name, is_active)
  values ('empty', 'Empty sequence', true) returning id into empty_id;

  result := public.followup_enroll(jsonb_build_object(
    'phone', '5125550129', 'sequence_slug', 'empty',
    'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('an empty sequence cannot be started',
    result ->> 'reason' = 'no_steps');

  update public.followup_sequences set is_active = false where id = empty_id;
  insert into public.followup_steps (sequence_id, position, body_en, body_es)
  values (empty_id, 1, 'en', 'es');

  result := public.followup_enroll(jsonb_build_object(
    'phone', '5125550129', 'sequence_slug', 'empty',
    'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('a paused sequence cannot be started',
    result ->> 'reason' = 'sequence_inactive');

  result := public.followup_enroll(jsonb_build_object(
    'phone', '5125550129', 'sequence_slug', 'no-such-sequence',
    'assigned_slack_user_id', 'U0PARALEGAL'));
  perform pg_temp.check('an unknown sequence is refused',
    result ->> 'reason' = 'sequence_not_found');
end;
$$;

-- ---------------------------------------------------------- audit trail

do $$
begin
  perform pg_temp.check('enrollments are logged',
    (select count(*) from public.followup_events where kind = 'enrolled') >= 5);
  perform pg_temp.check('stops are logged',
    (select count(*) from public.followup_events where kind like 'status_stopped%') >= 4);
  perform pg_temp.check('completion is logged',
    (select count(*) from public.followup_events where kind = 'status_completed') = 1);
end;
$$;

do $$ begin raise notice 'ALL TESTS PASSED'; end; $$;
