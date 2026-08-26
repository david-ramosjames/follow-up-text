insert into app_settings (key, value) values
  ('secondary_quo_number_id', 'null'::jsonb)
on conflict (key) do nothing;
