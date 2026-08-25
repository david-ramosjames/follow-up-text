-- New lead follow-up was written before {{case_type}} existed, so the first
-- texts said "accident" even when the router knew it was a slip and fall.
-- Fill the merge field so a preview on that track matches the card.

update followup_steps s
set body_en = replace(body_en, 'your accident', 'your {{case_type}}'),
    body_es = replace(body_es, 'su accidente', 'su {{case_type}}')
from followup_sequences q
where s.sequence_id = q.id and q.slug = 'new-lead';
