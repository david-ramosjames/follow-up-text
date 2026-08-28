-- Some texts in a sequence need a gentler (or just different) body for
-- particular case types — wrongful death, child abuse, sexual assault — without
-- splitting the whole sequence. Each step can carry optional alternate copy
-- and the phrases that must appear in the client's case_type to use it.

alter table followup_steps
  add column if not exists alt_case_types text[] not null default '{}',
  add column if not exists body_en_alt text,
  add column if not exists body_es_alt text,
  add column if not exists body_en_alt_night text,
  add column if not exists body_es_alt_night text;

alter table followup_steps
  drop constraint if exists followup_steps_alt_case_types_len,
  drop constraint if exists followup_steps_body_en_alt_length,
  drop constraint if exists followup_steps_body_es_alt_length,
  drop constraint if exists followup_steps_body_en_alt_night_length,
  drop constraint if exists followup_steps_body_es_alt_night_length;

alter table followup_steps
  add constraint followup_steps_alt_case_types_len
    check (cardinality(alt_case_types) <= 20),
  add constraint followup_steps_body_en_alt_length
    check (body_en_alt is null or char_length(body_en_alt) between 1 and 1200),
  add constraint followup_steps_body_es_alt_length
    check (body_es_alt is null or char_length(body_es_alt) between 1 and 1200),
  add constraint followup_steps_body_en_alt_night_length
    check (body_en_alt_night is null or char_length(body_en_alt_night) between 1 and 1200),
  add constraint followup_steps_body_es_alt_night_length
    check (body_es_alt_night is null or char_length(body_es_alt_night) between 1 and 1200);

comment on column followup_steps.alt_case_types is
  'Phrases that must appear in the client''s case_type for this step''s alternate copy. Empty means the usual copy.';
comment on column followup_steps.body_en_alt is
  'Used instead of body_en when case_type matches alt_case_types. Null falls back to body_en.';
comment on column followup_steps.body_es_alt is
  'Used instead of body_es when case_type matches alt_case_types. Null falls back to body_es.';
comment on column followup_steps.body_en_alt_night is
  'Night wording for the alternate copy. Null falls back to body_en_alt, then the usual night/day copy.';
comment on column followup_steps.body_es_alt_night is
  'Spanish night wording for the alternate copy. Null falls back like body_en_alt_night.';

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
      'body_en_alt', s.body_en_alt,
      'body_es_alt', s.body_es_alt,
      'body_en_alt_night', s.body_en_alt_night,
      'body_es_alt_night', s.body_es_alt_night,
      'alt_case_types', to_jsonb(s.alt_case_types),
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
