-- Answering a form fill immediately, and saying something different at 3am.
-- One transaction, rolled back. No psql meta-commands: this also runs through
-- the pg driver from the Node suite.
begin;

create or replace function pg_temp.check(label text, ok boolean, detail text default '')
returns void language plpgsql as $$
begin
  if ok then raise notice 'ok   %', label;
  else raise notice 'FAIL % %', label, detail; end if;
end $$;

do $$
declare
  immediate_seq followup_sequences;
  patient_seq followup_sequences;
  contact followup_contacts;
  result jsonb;
  e followup_enrollments;
  claimed jsonb;
  due_2 timestamptz;
begin
  insert into followup_operators (slack_user_id, display_name) values ('U0LEADOWNER', 'Owner');

  -- Answers at once; window is a narrow midday slot so "ignored the window" is
  -- unambiguous whatever time this test runs.
  insert into followup_sequences (slug, name, is_active, is_default, timezone,
                                  quiet_hours_start, quiet_hours_end, send_days, respond_immediately)
  values ('lead-now', 'Immediate', true, false, 'America/Chicago', 12, 13, '{1,2,3,4,5,6,7}', true)
  returning * into immediate_seq;

  insert into followup_steps (sequence_id, position, delay_minutes, body_en, body_es,
                              body_en_night, body_es_night, is_active)
  values (immediate_seq.id, 1, 0, 'Day one', 'Dia uno', 'Night one', 'Noche uno', true),
         (immediate_seq.id, 2, 240, 'Day two', 'Dia dos', null, null, true);

  -- Same window, but waits its turn.
  insert into followup_sequences (slug, name, is_active, is_default, timezone,
                                  quiet_hours_start, quiet_hours_end, send_days, respond_immediately)
  values ('lead-later', 'Patient', true, false, 'America/Chicago', 12, 13, '{1,2,3,4,5,6,7}', false)
  returning * into patient_seq;

  insert into followup_steps (sequence_id, position, delay_minutes, body_en, body_es, is_active)
  values (patient_seq.id, 1, 0, 'Day one', 'Dia uno', true);

  /* ------------------------------------------------ answering immediately */

  result := followup_enroll(jsonb_build_object(
    'phone', '512-555-0801', 'first_name', 'Amber', 'sequence_slug', 'lead-now',
    'assigned_slack_user_id', 'U0LEADOWNER', 'source', 'lead',
    'lead_source', 'website',
    'lead_detail', jsonb_build_object('confidence', 'high', 'case_type', 'hit by a truck')));

  perform pg_temp.check('a lead can start a series', (result ->> 'ok')::boolean);
  perform pg_temp.check(
    'an immediate sequence texts now, not when the window next opens',
    (result ->> 'next_run_at')::timestamptz <= now() + interval '1 minute',
    format('first text at %s, now is %s', result ->> 'next_run_at', now()));

  select * into e from followup_enrollments where id = (result ->> 'enrollment_id')::uuid;
  perform pg_temp.check('the lead''s provenance is kept', e.lead_source = 'website'
    and e.lead_detail ->> 'case_type' = 'hit by a truck');
  perform pg_temp.check('and it is recorded as a lead', e.source = 'lead');

  /* ---------------------------------- but only the first text ignores it */

  -- Send text one, then ask when text two is due.
  insert into followup_messages (enrollment_id, contact_id, direction, body, status, sent_at, created_at)
  values (e.id, e.contact_id, 'outbound', 'Day one', 'sent', now(), now());
  update followup_enrollments set next_position = 2, last_sent_at = now()
  where id = e.id returning * into e;

  due_2 := followup_step_due_at(e, immediate_seq, (select s from followup_steps s
    where s.sequence_id = immediate_seq.id and s.position = 2));

  perform pg_temp.check(
    'the second text is back inside the sending window',
    extract(hour from (due_2 at time zone 'America/Chicago'))::int = 12,
    format('text 2 due %s', due_2 at time zone 'America/Chicago'));

  /* ------------------------------------------------ a patient sequence */

  insert into followup_contacts (phone_e164) values ('+15125550802') returning * into contact;
  result := followup_enroll(jsonb_build_object(
    'phone', '512-555-0802', 'sequence_slug', 'lead-later',
    'assigned_slack_user_id', 'U0LEADOWNER', 'source', 'lead'));

  perform pg_temp.check(
    'a sequence without the flag still waits for its window',
    extract(hour from ((result ->> 'next_run_at')::timestamptz at time zone 'America/Chicago'))::int = 12,
    format('first text at %s', (result ->> 'next_run_at')::timestamptz at time zone 'America/Chicago'));

  /* -------------------------------------------------------- night copy */

  -- The claim carries both bodies plus whether it is night on the client's
  -- clock, so the dispatcher never has to work that out for itself.
  update followup_enrollments set next_position = 1, next_run_at = now() - interval '1 minute',
    last_sent_at = null where id = e.id;
  delete from followup_messages where enrollment_id = e.id;

  select value into claimed from followup_claim_due(5) as value
  where (value ->> 'enrollment_id')::uuid = e.id;

  perform pg_temp.check('the claim carries the night wording',
    claimed ->> 'body_en_night' = 'Night one' and claimed ->> 'body_es_night' = 'Noche uno');
  perform pg_temp.check('and says whether it is night for this client',
    (claimed -> 'is_night') is not null and jsonb_typeof(claimed -> 'is_night') = 'boolean');

  -- Force the answer both ways by moving the sequence's own night hours rather
  -- than a global setting. 12:00 through 11:00 wraps every hour except 11am.
  update followup_sequences
     set night_starts_hour = 12, night_ends_hour = 11
   where id = immediate_seq.id;
  update followup_enrollments set locked_until = null where id = e.id;
  select value into claimed from followup_claim_due(5) as value
  where (value ->> 'enrollment_id')::uuid = e.id;
  perform pg_temp.check('night hours come from the sequence',
    (claimed ->> 'is_night')::boolean =
    followup_is_night(now(), 'America/Chicago', 12, 11),
    claimed ->> 'is_night');
end $$;

rollback;
