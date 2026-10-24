import { one, rows, rpc, query } from "../db.js";
import { assigneeMentionSuffix, formatSlackMentions, parseSlackUserIds } from "../../shared/slackMentions.js";
import { displayPhone, enrollmentBlocks, postToThread, slackApi } from "./slack.js";
import { formatPhone, normalizePhone } from "../../shared/messaging.js";
import { currentFirm } from "./firms.js";
import { loadSettings, slackDefaultSequenceSlug } from "./settings.js";
import { mirrorTextSequence } from "./leadMirror.js";

export async function loadOperator(slackUserId) {
  const found = await rows(
    `select slack_user_id, display_name, email, is_supervisor, can_admin
     from followup_operators
     where slack_user_id = $1 and is_active
       and ($2::uuid is null or firm_id = $2)`,
    [slackUserId, currentFirm()?.id ?? null],
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
        + `${formatSlackMentions(result.assigned_slack_user_id)}. Stop that one first if you want to restart it.`;
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

export function canReviewSeries(operator, assignedSlackUserId) {
  if (!operator) return false;
  if (operator.is_supervisor || operator.can_admin) return true;
  const owners = parseSlackUserIds(assignedSlackUserId);
  if (!owners.length) return true;
  return owners.includes(operator.slack_user_id);
}

export async function findActiveEnrollmentByPhone(phone) {
  const e164 = normalizePhone(phone);
  if (!e164) return null;
  return one(
    `select e.id, e.assigned_slack_user_id, e.slack_channel_id, e.slack_thread_ts,
            e.status, c.first_name, c.phone_e164
     from followup_enrollments e
     join followup_contacts c on c.id = e.contact_id
     where c.phone_e164 = $1 and e.status = 'active'
       and ($2::uuid is null or e.firm_id = $2)
     order by e.started_at desc
     limit 1`,
    [e164, currentFirm()?.id ?? null],
  );
}

// A missed or Sona call should only open texts on the first contact. A number
// that already has a series, or any texts in or out, is already in a thread.
export async function findPriorConversation(phone) {
  const e164 = normalizePhone(phone);
  if (!e164) return null;
  const row = await one(
    `select c.id, c.last_inbound_at, c.last_outbound_at,
            (select e.id from followup_enrollments e
              where e.contact_id = c.id
              order by e.started_at desc
              limit 1) as enrollment_id,
            exists (select 1 from followup_messages m where m.contact_id = c.id) as has_messages
     from followup_contacts c
     where c.phone_e164 = $1 and ($2::uuid is null or c.firm_id = $2)
     limit 1`,
    [e164, currentFirm()?.id ?? null],
  );
  if (!row) return null;
  if (row.enrollment_id || row.has_messages || row.last_inbound_at || row.last_outbound_at) {
    return row;
  }
  return null;
}

export async function resolveSlackDefaultSequence() {
  const [settings, sequences] = await Promise.all([loadSettings(), activeSequences()]);
  const slug = slackDefaultSequenceSlug(settings, sequences);
  return {
    slug,
    sequence: sequences.find((sequence) => sequence.slug === slug) ?? null,
    sequences,
    settings,
  };
}

export async function startSeries(payload) {
  const { leadAllowsTexts } = await import("./leadDecision.js");
  const fromSlack = payload?.source !== "lead" || Boolean(payload?.callStart);
  let sequenceSlug = payload?.sequence_slug ?? null;
  if (fromSlack && !sequenceSlug) {
    sequenceSlug = (await resolveSlackDefaultSequence()).slug;
  }
  const decision = await leadAllowsTexts(payload?.phone, {
    manual: fromSlack,
    sequenceSlug,
  });
  if (!decision.allow) {
    return { ok: false, reason: `lead_decision:${decision.reason}` };
  }
  const enrollment = {
    ...payload,
    sequence_slug: decision.sequenceSlug || sequenceSlug || payload?.sequence_slug || null,
  };
  const result = await rpc("followup_enroll", { ...enrollment, firm_id: enrollment.firm_id ?? currentFirm()?.id ?? null });
  const phone = result?.phone || payload?.phone;
  if (result?.ok && phone) {
    mirrorTextSequence(phone).catch((error) => console.error("text sequence mirror failed", error));
  }
  return result;
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
    assignedUserName: result.assigned_slack_user_name ?? null,
    silentAssigned: Boolean(routing),
    mentionAssignees: Boolean((await loadSettings()).slack_tag_assignees),
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
  const result = await rpc("followup_stop", {
    enrollment_id: enrollmentId ?? null,
    phone: phone ?? null,
    reason,
    actor: actor ?? null,
    enforce_assignment: enforceAssignment,
  });
  const mirrored = result?.phone || phone;
  if (mirrored) {
    mirrorTextSequence(mirrored).catch((error) => console.error("text sequence mirror failed", error));
  }
  return result;
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
  call: "they spoke with the office",
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
  const ping = assigneeMentionSuffix(
    row.assigned_slack_user_id,
    (await loadSettings()).slack_tag_assignees,
  );

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
          text: `${sent} text${sent === 1 ? "" : "s"} went out`
            + (ping ? ` · was assigned to${ping}` : ""),
        }],
      },
    ],
  });
}

// Slack profile lookup, used so a series started by shorthand still shows a real
// name in the dashboard rather than a raw user ID.
export async function lookupSlackName(userId) {
  if (!userId) return null;
  const ids = parseSlackUserIds(userId);
  const toLookup = ids.length ? ids : [String(userId).trim()].filter(Boolean);
  const names = [];
  for (const id of toLookup) {
    const info = await slackApi("users.info", { user: id });
    if (!info?.ok) continue;
    const name = info.user?.profile?.display_name || info.user?.real_name || info.user?.name;
    if (name) names.push(name);
  }
  return names.length ? names.join(", ") : null;
}
