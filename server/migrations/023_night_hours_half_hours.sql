-- Night wording From/Until were whole hours, so 10:30 was not a choice.
-- Store them as hours from midnight in 30-minute steps (22.5 is 10:30 PM)
-- and decide night vs day by minutes, not by the clock hour alone.

alter table followup_sequences
  drop constraint if exists followup_sequences_night_hours_range;

alter table followup_sequences
  alter column night_starts_hour type numeric(4,1)
    using night_starts_hour::numeric(4,1),
  alter column night_ends_hour type numeric(4,1)
    using night_ends_hour::numeric(4,1);

alter table followup_sequences
  add constraint followup_sequences_night_hours_range
  check (
    night_starts_hour >= 12 and night_starts_hour < 24
    and night_ends_hour >= 0.5 and night_ends_hour <= 11.5
    and (night_starts_hour * 2) = trunc(night_starts_hour * 2)
    and (night_ends_hour * 2) = trunc(night_ends_hour * 2)
  );

comment on column followup_sequences.night_starts_hour is
  'Client-local start of night copy, hours from midnight, 30-minute steps. Wraps midnight with night_ends_hour.';
comment on column followup_sequences.night_ends_hour is
  'Client-local end of night copy, hours from midnight, 30-minute steps. Later texts still wait for quiet_hours_*.';

create or replace function followup_is_night(
  at timestamptz,
  tz text,
  start_hour numeric,
  end_hour numeric
)
returns boolean language plpgsql stable as $$
declare
  local timestamp;
  mins int;
begin
  if tz is null or tz = '' then tz := 'America/Chicago'; end if;
  if start_hour is null then start_hour := 21; end if;
  if end_hour is null then end_hour := 8; end if;
  local := coalesce(at, now()) at time zone tz;
  mins := extract(hour from local)::int * 60 + extract(minute from local)::int;
  return mins >= round(start_hour * 60)::int
      or mins < round(end_hour * 60)::int;
end;
$$;

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
      'firm_id', e.firm_id,
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
      'is_night', followup_is_night(now(), q.timezone, q.night_starts_hour, q.night_ends_hour),
      'append_opt_out_notice', q.append_opt_out_notice,
      'quo_number_id', coalesce(e.quo_number_id, q.quo_number_id, firm_setting_text(e.firm_id, 'default_quo_number_id', null)),
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
