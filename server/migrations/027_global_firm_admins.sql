-- A couple of people run every practice from one Google login. Per-firm Access
-- still decides who works Trucking Chicas day to day; this flag is who can
-- switch to any firm and edit it.

alter table followup_operators
  add column if not exists can_admin_all_firms boolean not null default false;

update followup_operators
set can_admin_all_firms = true, can_admin = true, is_active = true
where email in ('david@ramosjames.com', 'jon@ramosjames.com');
