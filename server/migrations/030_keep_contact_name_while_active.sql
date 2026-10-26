-- One contact per firm+phone. followup_enroll used to write first_name before
-- checking for an active series, so a later Slack/dashboard start on the same
-- number (even one that returned already_active) renamed the card and any
-- texts still waiting to send. Refuse first when a series is already running.

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
  v_quo text;
  v_firm uuid;
  v_step_count int;
begin
  v_firm := coalesce(nullif(payload ->> 'firm_id', '')::uuid, default_firm_id());

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

  v_quo := nullif(btrim(coalesce(payload ->> 'quo_number_id', '')), '');
  if v_quo is not null and not exists (
    select 1 from quo_numbers where id = v_quo and firm_id = v_firm and is_active
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_quo_number');
  end if;

  if nullif(btrim(coalesce(payload ->> 'sequence_slug', '')), '') is not null then
    select * into seq from followup_sequences
      where slug = lower(btrim(payload ->> 'sequence_slug')) and firm_id = v_firm;
  else
    select * into seq from followup_sequences
      where is_default and firm_id = v_firm order by created_at limit 1;
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

  select * into contact from followup_contacts
    where firm_id = v_firm and phone_e164 = v_phone;
  if contact.id is not null then
    select * into existing from followup_enrollments
      where contact_id = contact.id and status = 'active' limit 1;
    if existing.id is not null then
      return jsonb_build_object('ok', false, 'reason', 'already_active',
                                'enrollment_id', existing.id,
                                'assigned_slack_user_id', existing.assigned_slack_user_id,
                                'slack_channel_id', existing.slack_channel_id,
                                'slack_thread_ts', existing.slack_thread_ts);
    end if;
  end if;

  insert into followup_contacts as target (firm_id, phone_e164, first_name, last_name, language, case_type)
  values (
    v_firm,
    v_phone,
    nullif(btrim(coalesce(payload ->> 'first_name', '')), ''),
    nullif(btrim(coalesce(payload ->> 'last_name', '')), ''),
    coalesce(nullif(lower(btrim(coalesce(payload ->> 'language', ''))), ''), 'en'),
    nullif(btrim(coalesce(payload ->> 'case_type', '')), '')
  )
  on conflict (firm_id, phone_e164) do update
    set first_name = coalesce(nullif(btrim(coalesce(excluded.first_name, '')), ''), target.first_name),
        last_name = coalesce(nullif(btrim(coalesce(excluded.last_name, '')), ''), target.last_name),
        case_type = coalesce(nullif(btrim(coalesce(excluded.case_type, '')), ''), target.case_type),
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
    firm_id, sequence_id, contact_id, language, assigned_slack_user_id, assigned_slack_user_name,
    started_by_slack_user_id, slack_channel_id, slack_thread_ts, source, case_reference,
    case_type, lead_source, lead_detail, quo_number_id, next_position
  ) values (
    v_firm, seq.id, contact.id, v_language, v_assignee,
    nullif(btrim(coalesce(payload ->> 'assigned_slack_user_name', '')), ''),
    nullif(btrim(coalesce(payload ->> 'started_by_slack_user_id', '')), ''),
    nullif(btrim(coalesce(payload ->> 'slack_channel_id', '')), ''),
    nullif(btrim(coalesce(payload ->> 'slack_thread_ts', '')), ''),
    v_source,
    nullif(btrim(coalesce(payload ->> 'case_reference', '')), ''),
    coalesce(nullif(btrim(coalesce(payload ->> 'case_type', '')), ''), contact.case_type),
    nullif(btrim(coalesce(payload ->> 'lead_source', '')), ''),
    payload -> 'lead_detail',
    v_quo,
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
                             'source', v_source, 'quo_number_id', v_quo,
                             'first_send_at', enrollment.next_run_at),
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
    'case_type', enrollment.case_type,
    'quo_number_id', enrollment.quo_number_id,
    'slack_channel_id', enrollment.slack_channel_id,
    'slack_thread_ts', enrollment.slack_thread_ts,
    'firm_id', v_firm,
    'sequence', jsonb_build_object('slug', seq.slug, 'name', seq.name, 'timezone', seq.timezone)
  );
end;
$$;
