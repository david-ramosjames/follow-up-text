-- One access list, two ways to sign in.
--
-- Until now a person was identified only by their Slack ID, which made Google
-- sign-in impossible: Google gives us an email address, not a Slack ID. It also
-- meant the office manager who never touches Slack could not be given dashboard
-- access at all.
--
-- So a person now has an internal id and may carry a Slack ID, an email address,
-- or both:
--   * Slack ID  — lets them start and stop follow-ups from Slack
--   * email     — lets them sign in to the dashboard with Google
-- Either one alone is a valid person; what they can do follows from which
-- identities they have.

alter table followup_operators add column if not exists id uuid not null default gen_random_uuid();

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'followup_operators_pkey'
      and conrelid = 'followup_operators'::regclass
      and array_length(conkey, 1) = 1
      and (select attname from pg_attribute
           where attrelid = conrelid and attnum = conkey[1]) = 'slack_user_id'
  ) then
    alter table followup_operators drop constraint followup_operators_pkey;
    alter table followup_operators add primary key (id);
  end if;
end;
$$;

alter table followup_operators alter column slack_user_id drop not null;

-- A blank string is not an identity; normalize it away before the uniqueness
-- and presence rules below start caring about it.
update followup_operators set slack_user_id = null where btrim(coalesce(slack_user_id, '')) = '';
update followup_operators set email = null where btrim(coalesce(email, '')) = '';
update followup_operators set email = lower(btrim(email)) where email is not null;

alter table followup_operators drop constraint if exists followup_operators_slack_user_id_format;
alter table followup_operators add constraint followup_operators_slack_user_id_format
  check (slack_user_id is null or slack_user_id ~ '^[A-Z0-9]{6,}$');

alter table followup_operators drop constraint if exists followup_operators_email_format;
alter table followup_operators add constraint followup_operators_email_format
  check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

-- Emails are compared case-insensitively, because Google will happily hand back
-- Sam@Firm.com for the account added as sam@firm.com.
alter table followup_operators drop constraint if exists followup_operators_email_lowercase;
alter table followup_operators add constraint followup_operators_email_lowercase
  check (email is null or email = lower(email));

alter table followup_operators drop constraint if exists followup_operators_has_identity;
alter table followup_operators add constraint followup_operators_has_identity
  check (slack_user_id is not null or email is not null);

create unique index if not exists followup_operators_slack_user_id_key
  on followup_operators (slack_user_id) where slack_user_id is not null;

create unique index if not exists followup_operators_email_key
  on followup_operators (email) where email is not null;

/* ---------------------------------------------------------------- sessions */

-- Sessions now point at the person rather than copying their permissions, so
-- revoking somebody's access takes effect on their next request instead of
-- whenever their two-week cookie happens to expire.
alter table app_sessions add column if not exists user_id uuid
  references followup_operators(id) on delete cascade;
alter table app_sessions add column if not exists provider text;

update app_sessions s
set user_id = o.id,
    provider = coalesce(s.provider, 'slack')
from followup_operators o
where s.user_id is null and s.slack_user_id is not null and o.slack_user_id = s.slack_user_id;

-- A session with no user_id is the break-glass password sign-in.
update app_sessions set provider = 'password' where provider is null;

alter table app_sessions drop constraint if exists app_sessions_provider_check;
alter table app_sessions add constraint app_sessions_provider_check
  check (provider in ('slack', 'google', 'password'));

create index if not exists app_sessions_user_idx on app_sessions (user_id);
