-- Access is per practice: Ramos James people must not appear on Trucking
-- Chicas, and a Slack ID from one workspace must not authorise the other.
-- Existing rows land on the default firm, then any address at truckingchicas.com
-- is moved onto that firm.

alter table followup_operators add column if not exists firm_id uuid references firms(id);

update followup_operators
set firm_id = default_firm_id()
where firm_id is null;

update followup_operators o
set firm_id = f.id
from firms f
where o.email is not null
  and f.is_active
  and not f.is_default
  and (
    o.email like '%@truckingchicas.com'
    or o.email like '%@trucking-chicas.%'
  );

alter table followup_operators alter column firm_id set default default_firm_id();
alter table followup_operators alter column firm_id set not null;

drop index if exists followup_operators_email_key;
drop index if exists followup_operators_slack_user_id_key;

create unique index if not exists followup_operators_firm_email_key
  on followup_operators (firm_id, email) where email is not null;

create unique index if not exists followup_operators_firm_slack_user_id_key
  on followup_operators (firm_id, slack_user_id) where slack_user_id is not null;

create index if not exists followup_operators_firm_idx
  on followup_operators (firm_id);

-- A supervisor on one firm must not be able to stop a series on another.
create or replace function followup_stop(payload jsonb)
returns jsonb language plpgsql as $$
declare
  enrollment followup_enrollments;
  contact followup_contacts;
  v_reason text := coalesce(nullif(payload ->> 'reason', ''), 'manual');
  v_actor text := nullif(payload ->> 'actor', '');
  v_status text;
  v_enforce boolean := coalesce((payload ->> 'enforce_assignment')::boolean, false);
  v_supervisor boolean := false;
  v_phone text;
begin
  v_status := case v_reason
    when 'reply' then 'stopped_reply'
    when 'call' then 'stopped_call'
    when 'opt_out' then 'stopped_opt_out'
    else 'stopped_manual'
  end;

  if nullif(payload ->> 'enrollment_id', '') is not null then
    select * into enrollment from followup_enrollments
      where id = (payload ->> 'enrollment_id')::uuid for update;
  else
    v_phone := followup_normalize_phone(payload ->> 'phone');
    if v_phone is null then
      return jsonb_build_object('ok', false, 'reason', 'invalid_phone');
    end if;
    select e.* into enrollment
    from followup_enrollments e
    join followup_contacts c on c.id = e.contact_id
    where c.phone_e164 = v_phone and e.status = 'active'
    limit 1 for update of e;
  end if;

  if enrollment.id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_active_enrollment');
  end if;
  if enrollment.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'not_active', 'status', enrollment.status);
  end if;

  if v_enforce and v_actor is not null and v_actor <> enrollment.assigned_slack_user_id then
    select coalesce(is_supervisor, false) into v_supervisor
    from followup_operators
    where slack_user_id = v_actor and is_active and firm_id = enrollment.firm_id;
    if not coalesce(v_supervisor, false) then
      return jsonb_build_object('ok', false, 'reason', 'not_assigned',
                                'assigned_slack_user_id', enrollment.assigned_slack_user_id);
    end if;
  end if;

  update followup_enrollments
  set status = v_status, end_reason = v_reason, ended_by = coalesce(v_actor, 'system')
  where id = enrollment.id
  returning * into enrollment;

  select * into contact from followup_contacts where id = enrollment.contact_id;

  return jsonb_build_object(
    'ok', true,
    'enrollment_id', enrollment.id,
    'status', enrollment.status,
    'reason', v_reason,
    'phone', contact.phone_e164,
    'first_name', contact.first_name,
    'assigned_slack_user_id', enrollment.assigned_slack_user_id,
    'slack_channel_id', enrollment.slack_channel_id,
    'slack_thread_ts', enrollment.slack_thread_ts,
    'sent_count', (
      select count(*) from followup_messages
      where enrollment_id = enrollment.id and direction = 'outbound' and status <> 'failed'
    )
  );
end;
$$;
