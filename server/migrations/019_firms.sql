-- More than one practice can run in this deployment. Each firm has its own
-- sequences, contacts, lead channel, Slack workspace and sending numbers.
-- Ramos James is seeded as the default so every existing row keeps working.

create table if not exists firms (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  is_default boolean not null default false,
  is_active boolean not null default true,
  slack_bot_token text,
  slack_signing_secret text,
  slack_app_id text,
  slack_team_id text,
  quo_api_key text,
  quo_webhook_secret text,
  created_at timestamptz not null default now(),
  constraint firms_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{0,60}$')
);

create unique index if not exists firms_single_default_idx
  on firms (is_default) where is_default;

insert into firms (slug, name, is_default)
values ('ramos-james', 'Ramos James Law', true)
on conflict (slug) do nothing;

update firms f
set name = nullif(btrim(s.value #>> '{}'), '')
from app_settings s
where f.slug = 'ramos-james'
  and s.key = 'firm_name'
  and nullif(btrim(s.value #>> '{}'), '') is not null;

create or replace function default_firm_id()
returns uuid language sql stable as $$
  select id from firms where is_active order by is_default desc, created_at, name limit 1
$$;

alter table app_settings add column if not exists firm_id uuid references firms(id);
update app_settings set firm_id = default_firm_id() where firm_id is null;
alter table app_settings alter column firm_id set default default_firm_id();
alter table app_settings alter column firm_id set not null;

do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'app_settings_pkey'
      and conrelid = 'app_settings'::regclass
  ) then
    alter table app_settings drop constraint app_settings_pkey;
  end if;
end;
$$;

alter table app_settings add primary key (firm_id, key);

alter table quo_numbers add column if not exists firm_id uuid references firms(id);
update quo_numbers set firm_id = default_firm_id() where firm_id is null;
alter table quo_numbers alter column firm_id set default default_firm_id();
alter table quo_numbers alter column firm_id set not null;

alter table followup_sequences add column if not exists firm_id uuid references firms(id);
update followup_sequences set firm_id = default_firm_id() where firm_id is null;
alter table followup_sequences alter column firm_id set default default_firm_id();
alter table followup_sequences alter column firm_id set not null;

alter table followup_contacts add column if not exists firm_id uuid references firms(id);
update followup_contacts set firm_id = default_firm_id() where firm_id is null;
alter table followup_contacts alter column firm_id set default default_firm_id();
alter table followup_contacts alter column firm_id set not null;

alter table followup_enrollments add column if not exists firm_id uuid references firms(id);
update followup_enrollments e
set firm_id = q.firm_id
from followup_sequences q
where e.sequence_id = q.id and e.firm_id is null;
update followup_enrollments set firm_id = default_firm_id() where firm_id is null;
alter table followup_enrollments alter column firm_id set default default_firm_id();
alter table followup_enrollments alter column firm_id set not null;

alter table lead_observations add column if not exists firm_id uuid references firms(id);
update lead_observations set firm_id = default_firm_id() where firm_id is null;
alter table lead_observations alter column firm_id set default default_firm_id();
alter table lead_observations alter column firm_id set not null;

-- Postgres stores UNIQUE as a constraint that owns the index. Dropping the
-- index first fails; drop the constraint and the index goes with it.
alter table followup_sequences drop constraint if exists followup_sequences_slug_key;
drop index if exists followup_sequences_slug_key;
alter table followup_sequences drop constraint if exists followup_sequences_firm_slug_key;
alter table followup_sequences add constraint followup_sequences_firm_slug_key unique (firm_id, slug);

drop index if exists followup_sequences_single_default_idx;
create unique index if not exists followup_sequences_single_default_idx
  on followup_sequences (firm_id) where is_default;

alter table followup_contacts drop constraint if exists followup_contacts_phone_e164_key;
drop index if exists followup_contacts_phone_e164_key;
drop index if exists followup_contacts_firm_phone_key;
alter table followup_contacts drop constraint if exists followup_contacts_firm_phone_key;
alter table followup_contacts add constraint followup_contacts_firm_phone_key unique (firm_id, phone_e164);

alter table followup_sequences drop constraint if exists followup_sequences_quo_number_id_fkey;
alter table followup_enrollments drop constraint if exists followup_enrollments_quo_number_id_fkey;

alter table quo_numbers drop constraint if exists quo_numbers_pkey;
alter table quo_numbers add primary key (firm_id, id);

create or replace function setting_int(setting_key text, fallback int)
returns int language sql stable as $$
  select coalesce((
    select (value #>> '{}')::int from app_settings
    where key = setting_key and firm_id = default_firm_id()
  ), fallback);
$$;

create or replace function setting_bool(setting_key text, fallback boolean)
returns boolean language sql stable as $$
  select coalesce((
    select (value #>> '{}')::boolean from app_settings
    where key = setting_key and firm_id = default_firm_id()
  ), fallback);
$$;

create or replace function setting_text(setting_key text, fallback text)
returns text language sql stable as $$
  select coalesce(nullif((
    select value #>> '{}' from app_settings
    where key = setting_key and firm_id = default_firm_id()
  ), ''), fallback);
$$;

create or replace function firm_setting_text(p_firm uuid, setting_key text, fallback text)
returns text language sql stable as $$
  select coalesce(nullif((
    select value #>> '{}' from app_settings
    where key = setting_key and firm_id = p_firm
  ), ''), fallback);
$$;

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
      'is_night', (
        select extract(hour from (now() at time zone coalesce(nullif(q.timezone, ''), 'America/Chicago')))::int
               >= q.night_starts_hour
            or extract(hour from (now() at time zone coalesce(nullif(q.timezone, ''), 'America/Chicago')))::int
               < q.night_ends_hour
      ),
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

create or replace function followup_record_inbound(payload jsonb)
returns jsonb language plpgsql as $$
declare
  contact followup_contacts;
  enrollment followup_enrollments;
  v_phone text;
  v_firm uuid;
  v_kind text := coalesce(nullif(payload ->> 'kind', ''), 'message');
  v_is_stop boolean := coalesce((payload ->> 'is_stop')::boolean, false);
  v_is_start boolean := coalesce((payload ->> 'is_start')::boolean, false);
  v_message_id text := nullif(payload ->> 'quo_message_id', '');
  v_action text;
  v_stop jsonb;
begin
  v_phone := followup_normalize_phone(payload ->> 'phone');
  if v_phone is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_phone');
  end if;

  v_firm := coalesce(
    nullif(payload ->> 'firm_id', '')::uuid,
    (select firm_id from quo_numbers where id = nullif(payload ->> 'quo_number_id', '') limit 1),
    (select firm_id from quo_numbers
      where is_active and phone_e164 = followup_normalize_phone(payload ->> 'to_number')
      limit 1),
    default_firm_id()
  );

  if v_message_id is not null
     and exists (select 1 from followup_messages where quo_message_id = v_message_id) then
    return jsonb_build_object('ok', true, 'duplicate', true, 'action', 'none');
  end if;

  insert into followup_contacts (firm_id, phone_e164, last_inbound_at)
  values (v_firm, v_phone, now())
  on conflict (firm_id, phone_e164) do update set last_inbound_at = now()
  returning * into contact;

  if v_kind = 'message' then
    insert into followup_messages (
      contact_id, enrollment_id, direction, body, status,
      quo_message_id, quo_number_id, from_number, to_number
    )
    select contact.id,
           (select id from followup_enrollments where contact_id = contact.id
            order by created_at desc limit 1),
           'inbound', coalesce(payload ->> 'body', ''), 'received',
           v_message_id, nullif(payload ->> 'quo_number_id', ''),
           nullif(payload ->> 'from_number', ''), nullif(payload ->> 'to_number', '');
  end if;

  if v_is_start and contact.opted_out_at is not null then
    update followup_contacts
    set opted_out_at = null, opted_out_reason = null, opted_in_at = now()
    where id = contact.id
    returning * into contact;

    insert into followup_events (contact_id, kind, detail, actor)
    values (contact.id, 'opt_in', jsonb_build_object('body', payload ->> 'body'), 'contact');

    return jsonb_build_object('ok', true, 'action', 'opt_in', 'phone', contact.phone_e164,
                              'contact_id', contact.id, 'firm_id', v_firm,
                              'language', contact.language, 'first_name', contact.first_name);
  end if;

  if v_is_stop then
    update followup_contacts
    set opted_out_at = now(), opted_out_reason = 'keyword'
    where id = contact.id
    returning * into contact;

    insert into followup_events (contact_id, kind, detail, actor)
    values (contact.id, 'opt_out', jsonb_build_object('body', payload ->> 'body'), 'contact');

    v_action := 'opt_out';
  else
    v_action := case when v_kind = 'call' then 'call' else 'reply' end;
  end if;

  select * into enrollment from followup_enrollments
    where contact_id = contact.id and status = 'active' limit 1;

  if enrollment.id is not null then
    v_stop := followup_stop(jsonb_build_object(
      'enrollment_id', enrollment.id,
      'reason', case when v_action = 'opt_out' then 'opt_out' else v_action end,
      'actor', 'contact'
    ));
  end if;

  return jsonb_build_object(
    'ok', true,
    'action', v_action,
    'phone', contact.phone_e164,
    'contact_id', contact.id,
    'firm_id', v_firm,
    'language', contact.language,
    'first_name', contact.first_name,
    'body', payload ->> 'body',
    'stopped', v_stop,
    'enrollment_id', enrollment.id,
    'assigned_slack_user_id', enrollment.assigned_slack_user_id,
    'slack_channel_id', enrollment.slack_channel_id,
    'slack_thread_ts', enrollment.slack_thread_ts
  );
end;
$$;
