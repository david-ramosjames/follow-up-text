-- Text 1 ignores Earliest–Latest only when respond_immediately is on.
-- Night hours never send or hold a text; they only pick night vs usual copy.

comment on column followup_sequences.respond_immediately is
  'First text ignores the sending window. Later texts never do. Night hours only pick copy.';

create or replace function followup_step_due_at(
  enrollment followup_enrollments,
  seq followup_sequences,
  step followup_steps
)
returns timestamptz language sql stable as $$
  select case
    -- The first text of an immediate-response sequence, not yet sent: now.
    when seq.respond_immediately
     and not exists (
       select 1 from followup_messages m
        where m.enrollment_id = enrollment.id
          and m.direction = 'outbound' and m.status <> 'failed')
    then greatest(enrollment.started_at + make_interval(mins => step.delay_minutes), now())
    else followup_shift_into_window(
      greatest(
        coalesce(
          (select min(m.created_at) from followup_messages m
            where m.enrollment_id = enrollment.id
              and m.direction = 'outbound' and m.status <> 'failed'),
          enrollment.started_at
        ) + make_interval(mins => step.delay_minutes),
        coalesce(enrollment.last_sent_at, '-infinity'::timestamptz)
          + make_interval(mins => setting_int('min_gap_minutes', 60)),
        now()
      ),
      seq.timezone, seq.quiet_hours_start, seq.quiet_hours_end, seq.send_days
    )
  end;
$$;
