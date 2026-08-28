-- Earliest / latest send were whole hours, so 10:30 was not a choice. Store
-- them as hours from midnight in 30-minute steps (10.5 is 10:30) and shift
-- overdue texts by minutes, not by the clock hour alone.

alter table followup_sequences
  drop constraint if exists followup_sequences_quiet_hours_range;

alter table followup_sequences
  alter column quiet_hours_start type numeric(4,1)
    using quiet_hours_start::numeric(4,1),
  alter column quiet_hours_end type numeric(4,1)
    using quiet_hours_end::numeric(4,1);

alter table followup_sequences
  add constraint followup_sequences_quiet_hours_range
  check (
    quiet_hours_start >= 0 and quiet_hours_start < 24
    and quiet_hours_end > quiet_hours_start and quiet_hours_end <= 24
    and (quiet_hours_start * 2) = trunc(quiet_hours_start * 2)
    and (quiet_hours_end * 2) = trunc(quiet_hours_end * 2)
  );

comment on column followup_sequences.quiet_hours_start is
  'Client-local opening of the sending window, hours from midnight, 30-minute steps.';
comment on column followup_sequences.quiet_hours_end is
  'Client-local close of the sending window, hours from midnight, 30-minute steps. 24 is midnight.';

create or replace function followup_shift_into_window(
  earliest timestamptz,
  tz text,
  start_hour numeric,
  end_hour numeric,
  allowed_days smallint[]
)
returns timestamptz language plpgsql stable as $$
declare
  candidate timestamp;
  guard int := 0;
  start_mins int;
  end_mins int;
  mins int;
begin
  if earliest is null then return null; end if;
  if tz is null or tz = '' then tz := 'America/Chicago'; end if;
  if start_hour is null then start_hour := 0; end if;
  if end_hour is null then end_hour := 24; end if;
  if end_hour <= start_hour then return earliest; end if;
  if allowed_days is null or cardinality(allowed_days) = 0 then
    allowed_days := array[1, 2, 3, 4, 5, 6, 7]::smallint[];
  end if;

  start_mins := round(start_hour * 60)::int;
  end_mins := round(end_hour * 60)::int;
  candidate := earliest at time zone tz;

  loop
    guard := guard + 1;
    exit when guard > 21;

    mins := extract(hour from candidate)::int * 60 + extract(minute from candidate)::int;

    if mins >= end_mins then
      candidate := date_trunc('day', candidate) + interval '1 day' + make_interval(mins => start_mins);
      continue;
    end if;

    if mins < start_mins then
      candidate := date_trunc('day', candidate) + make_interval(mins => start_mins);
    end if;

    if not (extract(isodow from candidate)::smallint = any (allowed_days)) then
      candidate := date_trunc('day', candidate) + interval '1 day' + make_interval(mins => start_mins);
      continue;
    end if;

    exit;
  end loop;

  return candidate at time zone tz;
end;
$$;
