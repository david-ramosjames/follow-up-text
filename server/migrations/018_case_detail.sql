-- case_type is what the texts say ("car accident"). case_detail is the exact
-- situation for staff ("sexual assault, Uber driver, MDL") and is never sent.
alter table lead_observations
  add column if not exists case_detail text;

comment on column lead_observations.case_detail is
  'Exact situation for staff. Not merged into texts — that is case_type.';

comment on column lead_observations.case_type is
  'Noun phrase merged into texts as {{case_type}}, e.g. "car accident".';

comment on column followup_enrollments.case_type is
  'Noun phrase merged into copy as {{case_type}} — "car accident", not a file label. '
  'The exact situation, if any, lives on lead_observations.case_detail and in lead_detail.';
