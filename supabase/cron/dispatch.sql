-- Schedules the sender.
--
-- Nothing is sent until something calls followups-dispatch on a schedule. This
-- is the in-database option; any external scheduler that can POST a URL with a
-- header works just as well.
--
-- Run this once in the Supabase SQL editor, after replacing the two placeholders.
-- Both extensions are available on Supabase but are not enabled by default.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Keep the secret out of the job definition, which is world-readable to anyone
-- who can query cron.job.
select vault.create_secret(
  'PASTE_YOUR_FOLLOWUP_CRON_SECRET',
  'followup_cron_secret',
  'Shared secret for the followups-dispatch edge function'
);

select cron.schedule(
  'followups-dispatch',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/followups-dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'followup_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Every five minutes is a deliberate choice rather than a rate limit. Steps are
-- scheduled to the minute, so this is the worst-case lateness a client sees; the
-- database holds a five-minute lock on each claimed row, so overlapping runs
-- cannot double-send even if one run is slow.

-- Check what is scheduled:
--   select jobid, jobname, schedule, active from cron.job;
--
-- Check recent runs, including failures:
--   select start_time, status, return_message
--   from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'followups-dispatch')
--   order by start_time desc limit 20;
--
-- Pause sending without deleting anything:
--   select cron.alter_job(
--     (select jobid from cron.job where jobname = 'followups-dispatch'),
--     active := false);
--
-- Remove it:
--   select cron.unschedule('followups-dispatch');
