-- Spoken phrase for texts is case_type. This is the exact situation for staff
-- and is never merged into a text.
alter table lead_observations
  add column if not exists case_detail text;
