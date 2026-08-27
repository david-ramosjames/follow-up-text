-- lead_observations.firm_id defaulted to the default firm (Ramos James).
-- Catch-up for a second practice classified the post with that practice's
-- copy, then the insert left firm_id unset, so Trucking Chicas leads showed
-- up on Ramos James.

update lead_observations o
set firm_id = s.firm_id
from app_settings s
where s.key = 'lead_channel_id'
  and o.slack_channel_id = nullif(btrim(s.value #>> '{}'), '')
  and o.firm_id is distinct from s.firm_id;
