-- Staff-facing sequence titles. Slugs stay the same so a series already
-- running, and the lead router, keep using the same sequence.

update followup_sequences
set name = 'Missed Call'
where slug = 'new-lead'
   or lower(btrim(name)) in ('new lead', 'new lead follow-up', 'new lead follow up');

update followup_sequences
set name = 'Web Qualified'
where slug = 'qualified-lead'
   or lower(btrim(name)) in ('qualified lead', 'qualified lead follow-up');

update followup_sequences
set name = 'Web Referral'
where slug in ('referral', 'qualified-lead-copy')
   or lower(btrim(name)) in ('referral', 'referral (web lead)', 'referral follow-up');

update followup_sequences
set name = 'More Info'
where slug in ('more-info', 'more_info')
   or lower(btrim(name)) in ('more info', 'more info follow-up');

update followup_sequences
set name = 'Contract'
where slug in ('contract-follow-up', 'contract-followup', 'contract_follow_up', 'contract')
   or lower(btrim(name)) in ('contract follow-up', 'contract follow up', 'contract followup');
