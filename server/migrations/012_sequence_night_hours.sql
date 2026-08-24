-- Night wording hours belong on the sequence, not as a single global pair.
-- The first text of an Answer-immediately sequence can go out at any hour;
-- these two values split that 24-hour clock into usual copy vs night copy.
-- Seeded from the existing Settings values so current behaviour does not jump.

alter table followup_sequences
  add column if not exists night_starts_hour smallint not null default 21,
  add column if not exists night_ends_hour smallint not null default 8;

update followup_sequences
set night_starts_hour = setting_int('night_starts_hour', 21),
    night_ends_hour = setting_int('night_ends_hour', 8);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'followup_sequences_night_hours_range'
  ) then
    alter table followup_sequences
      add constraint followup_sequences_night_hours_range
      check (night_starts_hour between 12 and 23
         and night_ends_hour between 1 and 11);
  end if;
end $$;

comment on column followup_sequences.night_starts_hour is
  'Client-local hour from which the first text uses night copy. Wraps midnight with night_ends_hour.';
comment on column followup_sequences.night_ends_hour is
  'Client-local hour at which night copy stops. Later texts still wait for quiet_hours_*.';

-- Identify the firm by name on the first text (day and night), both tracks.
update followup_steps s
set body_en = 'Hi {{first_name}}, this is {{firm_name}}. Thank you for contacting us about your {{case_type}}. Please save this number so we can reach you.',
    body_es = 'Hola {{first_name}}, le escribimos de {{firm_name}}. Gracias por contactarnos sobre su {{case_type}}. Guarde este numero.',
    body_en_night = 'Hi {{first_name}}, this is {{firm_name}}. We got your {{case_type}} tonight. Please save this number. We will call you in the morning.',
    body_es_night = 'Hola {{first_name}}, le escribimos de {{firm_name}}. Recibimos su {{case_type}} esta noche. Le llamamos mañana.'
from followup_sequences q
where s.sequence_id = q.id and q.slug = 'qualified-lead' and s.position = 1;

update followup_steps s
set body_en = 'Hi {{first_name}}, this is {{firm_name}}. Thanks for contacting us about your {{case_type}}. We are referring you out. Please save this number.',
    body_es = 'Hola {{first_name}}, le escribimos de {{firm_name}}. Lo referimos a otro abogado. Guarde este numero.',
    body_en_night = 'Hi {{first_name}}, this is {{firm_name}}. We got your {{case_type}} tonight. We will refer you out in the morning. Please save this number.',
    body_es_night = 'Hola {{first_name}}, le escribimos de {{firm_name}}. Recibimos su {{case_type}} esta noche. Lo referimos mañana.'
from followup_sequences q
where s.sequence_id = q.id and q.slug = 'referral' and s.position = 1;

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
      -- Night wording wraps midnight, on this sequence's hours, client's clock.
      'is_night', (
        select extract(hour from (now() at time zone coalesce(nullif(q.timezone, ''), 'America/Chicago')))::int
               >= q.night_starts_hour
            or extract(hour from (now() at time zone coalesce(nullif(q.timezone, ''), 'America/Chicago')))::int
               < q.night_ends_hour
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
