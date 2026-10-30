import { one } from "../db.js";
import { shouldPostSlackAlert } from "../../shared/slackAlerts.js";

export { isWeekendInTimezone, shouldPostSlackAlert } from "../../shared/slackAlerts.js";

export async function sequenceAllowsSlackAlert(enrollmentId, at = new Date()) {
  if (!enrollmentId) return true;
  const row = await one(
    `select q.weekend_slack_alerts, q.timezone
     from followup_enrollments e
     join followup_sequences q on q.id = e.sequence_id
     where e.id = $1`,
    [enrollmentId],
  );
  return shouldPostSlackAlert(row || {}, at);
}
