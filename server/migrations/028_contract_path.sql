-- Intake Engine marks some parents 📝 *Contract path*. Sign Flow then replies
-- 📝 *Contract sent to be signed*. Those leads must not get the abandoned SMS
-- unless the signing link never arrives.

alter table lead_observations drop constraint if exists lead_observations_outcome;
alter table lead_observations add constraint lead_observations_outcome check (outcome in (
  'started', 'preview_only', 'not_a_lead', 'no_phone', 'ignored_sender',
  'enroll_failed', 'no_owner', 'classifier_failed',
  'waiting_contract', 'contract_sent', 'contract_notice'
));

create index if not exists lead_observations_waiting_contract_idx
  on lead_observations (firm_id, created_at)
  where outcome = 'waiting_contract';
