-- Saving Settings copies "Firm name" onto whichever firm is selected. If that
-- field still said the other practice's name, Ramos James ended up with the
-- same label as the new firm and the switcher showed it twice.

update app_settings s
set value = to_jsonb('Ramos James Law'::text), updated_at = now()
from firms f
where s.firm_id = f.id
  and s.key = 'firm_name'
  and f.slug = 'ramos-james'
  and exists (
    select 1 from firms other
    where other.id <> f.id and other.is_active and other.name = f.name
  );

update firms f
set name = 'Ramos James Law'
where f.slug = 'ramos-james'
  and exists (
    select 1 from firms other
    where other.id <> f.id and other.is_active and other.name = f.name
  );
