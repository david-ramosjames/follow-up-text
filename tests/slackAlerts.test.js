import assert from "node:assert/strict";
import test from "node:test";
import { isWeekendInTimezone, shouldPostSlackAlert } from "../shared/slackAlerts.js";

test("weekend detection uses the sequence timezone", () => {
  // Saturday 2026-10-31 15:00 UTC = Saturday morning in Chicago.
  const saturday = new Date("2026-10-31T15:00:00Z");
  assert.equal(isWeekendInTimezone("America/Chicago", saturday), true);

  // Monday 2026-11-02 15:00 UTC = Monday morning in Chicago.
  const monday = new Date("2026-11-02T15:00:00Z");
  assert.equal(isWeekendInTimezone("America/Chicago", monday), false);
});

test("weekend Slack alerts default on", () => {
  const saturday = new Date("2026-10-31T15:00:00Z");
  assert.equal(shouldPostSlackAlert({}, saturday), true);
  assert.equal(shouldPostSlackAlert({ weekend_slack_alerts: true, timezone: "America/Chicago" }, saturday), true);
});

test("weekend Slack alerts can be switched off", () => {
  const saturday = new Date("2026-10-31T15:00:00Z");
  const monday = new Date("2026-11-02T15:00:00Z");
  const sequence = { weekend_slack_alerts: false, timezone: "America/Chicago" };
  assert.equal(shouldPostSlackAlert(sequence, saturday), false);
  assert.equal(shouldPostSlackAlert(sequence, monday), true);
});
