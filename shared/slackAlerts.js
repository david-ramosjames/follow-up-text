/** Saturday or Sunday in the sequence's client timezone. */
export function isWeekendInTimezone(timezone, at = new Date()) {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "America/Chicago",
    weekday: "short",
  }).format(at);
  return day === "Sat" || day === "Sun";
}

/**
 * Sequences default to posting Slack on weekends. When weekend_slack_alerts is
 * off, Saturday/Sunday posts for that sequence are skipped; texts still send.
 */
export function shouldPostSlackAlert(sequence = {}, at = new Date()) {
  if (sequence == null) return true;
  if (sequence.weekend_slack_alerts === false || sequence.weekend_slack_alerts === "false") {
    return !isWeekendInTimezone(sequence.timezone, at);
  }
  return true;
}
