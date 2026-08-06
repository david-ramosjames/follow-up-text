-- Does a series started after hours fire several texts at once when the window
-- reopens? Everything here is one transaction and rolls back. No psql
-- meta-commands: this also runs through the pg driver from the Node suite.
begin;

create or replace function pg_temp.check(label text, ok boolean, detail text default '')
returns void language plpgsql as $$
begin
  if ok then raise notice 'ok   %', label;
  else raise notice 'FAIL % %', label, detail; end if;
end $$;

do $$
declare
  seq followup_sequences;
  contact followup_contacts;
  e followup_enrollments;
  started timestamptz;
  due_2 timestamptz;
  due_3 timestamptz;
  gap_hours numeric;
begin
  -- 9am-7pm, every day, so only the hour is under test.
  insert into followup_sequences (slug, name, is_active, is_default, timezone,
                                  quiet_hours_start, quiet_hours_end, send_days)
  values ('catchup', 'Catch-up', true, false, 'America/Chicago', 9, 19, '{1,2,3,4,5,6,7}')
  returning * into seq;

  -- Immediately, +4h, +8h: three touches inside what would be one working day.
  insert into followup_steps (sequence_id, position, delay_minutes, body_en, body_es, is_active)
  values (seq.id, 1, 0,   'One',   'Uno',  true),
         (seq.id, 2, 240, 'Two',   'Dos',  true),
         (seq.id, 3, 480, 'Three', 'Tres', true);

  insert into followup_contacts (phone_e164) values ('+15125550701') returning * into contact;

  -- Started at 11pm, four hours after the window shut.
  started := '2026-08-04 23:00:00-05'::timestamptz;
  insert into followup_enrollments (sequence_id, contact_id, language, assigned_slack_user_id,
                                    started_at, next_position, next_run_at, status)
  values (seq.id, contact.id, 'en', 'U0TEST', started, 1,
          followup_shift_into_window(started, seq.timezone, 9, 19, '{1,2,3,4,5,6,7}'), 'active')
  returning * into e;

  perform pg_temp.check(
    'a series started at 11pm holds its first text until 9am',
    (e.next_run_at at time zone 'America/Chicago')::time = '09:00'::time,
    (e.next_run_at at time zone 'America/Chicago')::text);

  -- Pretend 9am has arrived and text one has just gone out.
  insert into followup_messages (enrollment_id, contact_id, direction, body, status, sent_at, created_at)
  values (e.id, contact.id, 'outbound', 'One', 'sent', e.next_run_at, e.next_run_at);
  update followup_enrollments
  set next_position = 2, last_sent_at = e.next_run_at
  where id = e.id returning * into e;

  due_2 := followup_step_due_at(e, seq, (select s from followup_steps s
                                          where s.sequence_id = seq.id and s.position = 2));
  gap_hours := extract(epoch from (due_2 - e.last_sent_at)) / 3600;

  perform pg_temp.check(
    'text two does not follow text one immediately',
    gap_hours >= 0.9,
    format('gap was %s hours (text 2 due %s)', round(gap_hours, 2),
           due_2 at time zone 'America/Chicago'));

  -- And again for the third, which was also overdue on paper.
  insert into followup_messages (enrollment_id, contact_id, direction, body, status, sent_at, created_at)
  values (e.id, contact.id, 'outbound', 'Two', 'sent', due_2, due_2);
  update followup_enrollments set next_position = 3, last_sent_at = due_2
  where id = e.id returning * into e;

  due_3 := followup_step_due_at(e, seq, (select s from followup_steps s
                                          where s.sequence_id = seq.id and s.position = 3));
  gap_hours := extract(epoch from (due_3 - e.last_sent_at)) / 3600;

  perform pg_temp.check(
    'nor does text three follow text two immediately',
    gap_hours >= 0.9,
    format('gap was %s hours (text 3 due %s)', round(gap_hours, 2),
           due_3 at time zone 'America/Chicago'));

  perform pg_temp.check(
    'every catch-up text still lands inside the sending window',
    (due_2 at time zone 'America/Chicago')::time between '09:00' and '19:00'
    and (due_3 at time zone 'America/Chicago')::time between '09:00' and '19:00',
    format('%s / %s', due_2 at time zone 'America/Chicago', due_3 at time zone 'America/Chicago'));
end $$;

rollback;
