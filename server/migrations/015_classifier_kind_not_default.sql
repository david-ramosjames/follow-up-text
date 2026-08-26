-- Read as is only Qualified lead or Referral. Cards recorded while those
-- tracks were switched off stored the hand-start default (new-lead) instead.

update lead_observations
   set classifier_slug = 'qualified-lead'
 where classifier_slug = 'new-lead';

update lead_observations
   set classifier_slug = 'qualified-lead'
 where classifier_slug is not null
   and classifier_slug not in ('qualified-lead', 'referral')
   and classifier_error is null;
