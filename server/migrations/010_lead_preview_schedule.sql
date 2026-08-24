-- Watch-and-record should show whether the first text would use night wording,
-- and when the next one would actually go out. Later texts always wait for the
-- sending window, so a 4-hour gap after an 11pm first text becomes 9am, not 3am.
alter table lead_observations
  add column if not exists preview_is_night boolean,
  add column if not exists preview_next_at timestamptz;

comment on column lead_observations.preview_is_night is
  'True when the first-text preview used night wording, judged on the sequence timezone.';
comment on column lead_observations.preview_next_at is
  'When the second text would be due after shifting into the sending window.';
