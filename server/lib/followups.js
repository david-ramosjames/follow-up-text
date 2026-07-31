import { rows, rpc, query } from "../db.js";
import { displayPhone, enrollmentBlocks, postToThread, slackApi } from "./slack.js";

export async function loadOperator(slackUserId) {
  const found = await rows(
    `select slack_user_id, display_name, email, is_supervisor, can_admin
     from followup_operators where slack_user_id = $1 and is_active`,
    [slackUserId],
  );
  return found[0] ?? null;
}

export async function activeSequences() {
  return rows(
    `select slug, name, is_default, timezone from followup_sequences
     where is_active order by is_default desc, name`,
  );
}

// Turns a database refusal into something a paralegal can act on, in the same
// words whether it came back from the form or from the shorthand command.
export function enrollFailureText(result, phone) {
  switch (result?.reason) {
    case "invalid_phone":
      return `:warning: \`${phone}\` does not read as a mobile number. Try it as 512-555-0123.`;
    case "already_active":
      return `:information_source: That number already has a series running, assigned to `
        + `<@${result.assigned_slack_user_id}>. Stop that one first if you want to restart it.`;
    case "opted_out":
      return ":no_entry: That number has opted out of texts, so no series can be started. "
        + "They would need to text START themselves to opt back in.";
    case "sequence_not_found":
      return ":warning: I could not find that sequence. Run `/followup` to pick from the list.";
    case "sequence_inactive":
      return ":warning: That sequence is switched off. Turn it on in the dashboard first.";
    case "no_steps":
      return ":warning: That sequence has no texts in it yet.";
    case "missing_assignee":
      return ":warning: Every series needs somebody assigned to it.";
    default:
      return `:warning: The series could not be started (${result?.reason ?? "unknown error"}).`;
  }
}

export const ENROLL_FIELD_ERRORS = {
  invalid_phone: { field: "phone", text: "That does not read as a mobile number. Try 512-555-0123." },
  already_active: { field: "phone", text: "This client already has a series running." },
  opted_out: { field: "phone", text: "This client has opted out of texts." },
  no_steps: { field: "sequence", text: "That sequence has no texts in it yet." },
  sequence_inactive: { field: "sequence", text: "That sequence is switched off." },
  sequence_not_found: { field: "sequence", text: "That sequence no longer exists." },
};

export async function startSeries(payload) {
  return rpc("followup_enroll", payload);
}

// Posts the confirmation card. When the series came from a message or a thread,
// this posts as a threaded reply and records the ts, so the Stop button and every
// later update stay in that one conversation.
export async function announceEnrollment(result, { fallbackResponseUrl = null } = {}) {
  const phone = await displayPhone(String(result.phone));
  const blocks = enrollmentBlocks({
    enrollmentId: String(result.enrollment_id),
    phone,
    firstName: result.first_name ?? null,
    language: String(result.language),
    sequenceName: result.sequence?.name ?? "Follow-ups",
    stepCount: Number(result.step_count ?? 0),
    nextRunAt: result.next_run_at ?? null,
    assignedUserId: String(result.assigned_slack_user_id),
    caseReference: result.case_reference ?? null,
    timezone: result.sequence?.timezone ?? "America/Chicago",
  });
  const text = `Follow-up texts started for ${phone}`;

  const posted = await postToThread({
    channel: result.slack_channel_id,
    threadTs: result.slack_thread_ts,
    text,
    blocks,
  });

  if (posted?.ok && posted.ts) {
    await query(
      // If this series had no thread yet, its own confirmation becomes the thread
      // that later replies and stop notices hang off.
      `update followup_enrollments
       set slack_message_ts = $2, slack_thread_ts = coalesce(slack_thread_ts, $2)
       where id = $1`,
      [result.enrollment_id, String(posted.ts)],
    );
    return;
  }

  if (fallbackResponseUrl) {
    await fetch(fallbackResponseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", text, blocks }),
    }).catch((error) => console.error("Slack response_url failed", error));
  }
}

export async function stopSeries({ enrollmentId, phone, actor, enforceAssignment = false, reason = "manual" }) {
  return rpc("followup_stop", {
    enrollment_id: enrollmentId ?? null,
    phone: phone ?? null,
    reason,
    actor: actor ?? null,
    enforce_assignment: enforceAssignment,
  });
}

export async function announceStop(result, actorLabel) {
  const phone = await displayPhone(String(result.phone));
  const sent = Number(result.sent_count ?? 0);
  await postToThread({
    channel: result.slack_channel_id,
    threadTs: result.slack_thread_ts,
    text: `:octagonal_sign: ${actorLabel} stopped follow-ups for ${phone} after ${sent} `
      + `text${sent === 1 ? "" : "s"}.`,
  });
}

// Slack profile lookup, used so a series started by shorthand still shows a real
// name in the dashboard rather than a raw user ID.
export async function lookupSlackName(userId) {
  if (!userId) return null;
  const info = await slackApi("users.info", { user: userId });
  if (!info?.ok) return null;
  return info.user?.profile?.display_name || info.user?.real_name || info.user?.name || null;
}
