-- The track dropdown redraws sequence_slug so you can preview a different
-- first text. That used to overwrite the only copy of what the classifier
-- picked. Keep that decision on its own so the Leads page can show Qualified
-- vs Referral in the facts, before the assigned track.

alter table lead_observations
  add column if not exists classifier_slug text;

comment on column lead_observations.classifier_slug is
  'What the model chose (qualified-lead or referral) before a track was assigned. '
  'Not updated when someone previews a different sequence.';

-- Existing cards have no separate copy. The assigned slug is the closest record
-- of the original decision, except where a person already used the dropdown.
update lead_observations
   set classifier_slug = sequence_slug
 where classifier_slug is null
   and sequence_slug is not null
   and classifier_error is null;
