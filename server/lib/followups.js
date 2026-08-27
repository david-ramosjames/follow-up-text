import { one, rows, rpc, query } from "../db.js";
import { displayPhone, enrollmentBlocks, postToThread, slackApi } from "./slack.js";
import { formatPhone } from "../../shared/messaging.js";
import { currentFirm } from "./firms.js";

export async function loadOperator(slackUserId) {
  const found = await rows(
    `select slack_user_id, display_name, email, is_supervisor, can_admin
     from followup_operators where slack_user_id = $1 and is_active`,
    [slackUserId],
  );
  return found[0] ?? null;
}

export async function activeSequences() {
  const id = currentFirm()?.id;
  if (!id) return [];
  return rows(
    `select slug, name, is_default, timezone from followup_sequences
     where is_active and firm_id = $1 order by is_default desc, name`,
    [id],
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
    case "unknown_quo_number":
      return ":warning: That sending number is not in Quo any more. Leave it blank to use the default.";
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
  unknown_quo_number: { field: "send_from", text: "That sending number is not in Quo any more." },
};

export async function startSeries(payload) {
  return rpc("followup_enroll", { ...payload, firm_id: payload.firm_id ?? currentFirm()?.id ?? null });
}

// Posts the confirmation card. When the series came from a message or a thread,
// this posts as a threaded reply and records the ts, so the Stop button and every
// later update stay in that one conversation.
export async function announceEnrollment(result, {
  fallbackResponseUrl = null,
  channel = null,
  threadTs = null,
  routing = null,
} = {}) {
  const phone = await displayPhone(String(result.phone));
  let fromNumber = null;
  if (result.quo_number_id) {
    const row = await one("select label, phone_e164 from quo_numbers where id = $1", [result.quo_number_id]);
    if (row) {
      fromNumber = row.label
        ? `${row.label} (${formatPhone(row.phone_e164) || row.phone_e164})`
        : (formatPhone(row.phone_e164) || row.phone_e164);
    }
  }
  let rerouteOptions = [];
  if (routing) {
    rerouteOptions = (await activeSequences()).slice(0, 100).map((sequence) => ({
      text: { type: "plain_text", text: sequence.name.slice(0, 75) },
      value: `${result.enrollment_id}|${sequence.slug}`,
    }));
  }
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
    fromNumber,
    routing,
    rerouteOptions,
  });
  const text = `Follow-up texts started for ${phone}`;

  const posted = await postToThread({
    channel: channel || result.slack_channel_id,
    threadTs: threadTs || result.slack_thread_ts,
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
    return posted;
  }

  console.error(
    `enrollment card did not post for ${result.enrollment_id}: ${posted?.error ?? "unknown"}`,
  );

  if (fallbackResponseUrl) {
    await fetch(fallbackResponseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "in_channel", text, blocks }),
    }).catch((error) => console.error("Slack response_url failed", error));
    return { ok: true, degraded: true };
  }
  return posted ?? { ok: false, error: "no_post" };
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
  await retireStartCard(result.enrollment_id);
}

const ENDED_LABELS = {
  reply: "the client replied",
  call: "the client called back",
  opt_out: "the client texted STOP",
  manual: "somebody stopped it",
  sequence_complete: "every text went out with no reply",
  failed: "the texts kept failing",
};

// Rewrites the original "Follow-up texts started" card once the series is over,
// so the red Stop button goes away with it. Clicking a stale one was already
// harmless — the database refuses a second stop — but a live-looking button on a
// finished series is a question every paralegal has to stop and answer.
export async function retireStartCard(enrollmentId) {
  if (!enrollmentId) return;

  const row = await one(
    `select e.status, e.end_reason, e.slack_channel_id, e.slack_message_ts,
            e.assigned_slack_user_id, c.phone_e164, c.first_name,
            (select count(*) from followup_messages m
              where m.enrollment_id = e.id and m.direction = 'outbound' and m.status <> 'failed') as sent_count
     from followup_enrollments e
     join followup_contacts c on c.id = e.contact_id
     where e.id = $1`,
    [enrollmentId],
  );

  // No stored message means the confirmation never posted — nothing to retire.
  if (!row?.slack_message_ts || !row.slack_channel_id || row.status === "active") return;

  const phone = await displayPhone(String(row.phone_e164));
  const who = row.first_name ? `*${row.first_name}* ${phone}` : `*${phone}*`;
  const sent = Number(row.sent_count ?? 0);
  const why = ENDED_LABELS[row.end_reason] ?? String(row.end_reason ?? "it ended").replace(/_/g, " ");

  await slackApi("chat.update", {
    channel: row.slack_channel_id,
    ts: row.slack_message_ts,
    text: `Follow-up texts for ${phone} have stopped`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:white_check_mark: Follow-up texts for ${who} have stopped — ${why}.`,
        },
      },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `${sent} text${sent === 1 ? "" : "s"} went out · was assigned to `
            + `<@${row.assigned_slack_user_id}>`,
        }],
      },
    ],
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
