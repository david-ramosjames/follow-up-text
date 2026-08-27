import express from "express";
import {
  extractPhones,
  formatPhone,
  maskPhone,
  normalizePhone,
  truncateChars,
} from "../../shared/messaging.js";
import { flattenSlackMessage } from "../../shared/leads.js";
import { parseStartArgs } from "../../shared/startArgs.js";
import { one, rows, rpc } from "../db.js";
import { assessLeadPost } from "../lib/leads.js";
import { previewFirstText } from "../lib/previewText.js";
import { loadSettings } from "../lib/settings.js";
import {
  activeSequences,
  announceEnrollment,
  announceStop,
  ENROLL_FIELD_ERRORS,
  enrollFailureText,
  loadOperator,
  lookupSlackName,
  retireStartCard,
  startSeries,
  stopSeries,
} from "../lib/followups.js";
import { listQuoNumbers } from "../lib/quo.js";
import { currentFirm, runWithFirm, slackAppId, slackBotToken } from "../lib/firms.js";
import {
  displayPhone,
  formatWhen,
  noPhoneModal,
  respondToUrl,
  slackApi,
  startModal,
  verifySlackRequest,
} from "../lib/slack.js";

export const slackRouter = express.Router();

const ephemeral = (text) => ({ response_type: "ephemeral", text });

const HELP = [
  "*Client follow-up texts*",
  "",
  "*From any message or thread* — hover the message, hit `⋯`, choose *Start follow-up texts*. "
    + "The number is read out of the message and every update comes back in that thread.",
  "*In a thread* — `@sms-follow-up start 512-555-0123 es Maria`.",
  "",
  "*Commands*",
  "`/followup` — open the start form",
  "`/followup 512-555-0123 es Maria` — start straight away (`start` is optional with a number)",
  "`/followup stop 512-555-0123` — stop a series you own",
  "`/followup status 512-555-0123` — where a client is in their series",
  "`/followup list` — everything you have running",
  "`/followup help` — this",
  "",
  "In the shorthand the order does not matter: anything shaped like a phone number is the "
    + "number, `en`/`es` sets the language, a sequence name picks the sequence, `from` plus the "
    + "Quo line's name (as labelled in Quo) sends from that number, an `@mention` "
    + "assigns it, and whatever is left is the first name. Leave the language out and it uses "
    + "whatever you last used for that number; leave the name out and the text says \"there\". "
    + "Leave `from` out and it uses the sequence's number, or the default under Settings.",
  "",
  "*Inside a thread, use the mention, not the command.* Slack tells a slash command which "
    + "channel it was run in but not which thread, so `/followup` always confirms at the top of "
    + "the channel. `@sms-follow-up start …` and the `⋯` menu both keep to the thread.",
  "",
  "A series stops on its own when the client replies, calls back, or texts STOP — `stop` is "
    + "for when they re-engage somewhere this cannot see.",
].join("\n");

const MENTION_SYNTAX = [
  "`@sms-follow-up start 512-555-0123 es Maria` — start a series",
  "`@sms-follow-up start 512-555-0123 from Intake` — start from that Quo line (use the name as it appears in Quo)",
  "`@sms-follow-up stop 512-555-0123` — stop one you own",
  "`@sms-follow-up status 512-555-0123` — where a client is",
  "`@sms-follow-up list` — everything you have running",
].join("\n");

const MENTION_ORDER_NOTE = "The order does not matter: anything shaped like a phone number is the "
  + "client's number, `en`/`es` sets the language, `from` plus the Quo line's name (or last four "
  + "digits) sends from that line, an `@mention` assigns it to somebody else, and whatever is left over "
  + "is the client's first name.";

/* ------------------------------------------------------------ arg parsing */

const VERBS = ["start", "stop", "status", "list", "help"];

// How many single-character edits apart two words are. Only used to turn "stauts"
// into "did you mean status?", so the cheap full matrix is more than enough.
function editDistance(a, b) {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

// A word that was meant to be a verb but is not one. Getting this wrong in the
// permissive direction is expensive: an unrecognised first word used to fall
// through to start and become {{first_name}}, so `@sms-follow-up stauts 512…`
// texted the client "Hi stauts,". Better to ask than to guess.
function nearestVerb(word) {
  const lower = String(word ?? "").toLowerCase();
  if (!/^[a-z]{2,}$/.test(lower)) return null;
  if (VERBS.includes(lower)) return null;

  let best = null;
  let bestDistance = Infinity;
  for (const verb of VERBS) {
    const distance = editDistance(lower, verb);
    // Two edits on a short word turns almost anything into almost anything, so
    // scale the tolerance: 1 for four letters or fewer, 2 above that.
    const allowed = Math.min(verb.length, lower.length) <= 4 ? 1 : 2;
    if (distance <= allowed && distance < bestDistance) {
      best = verb;
      bestDistance = distance;
    }
  }
  return best;
}


function takePhone(tokens) {
  return { phone: extractPhones(tokens.join(" "))[0] ?? null };
}

/* ---------------------------------------------------------------- actions */

async function sendingNumbers() {
  return (await listQuoNumbers()).filter((number) => number.is_active);
}

async function sendingAliases() {
  const settings = await loadSettings();
  const secondary = settings.secondary_quo_number_id;
  return secondary ? { secondary, "2nd": secondary } : {};
}

async function sendingOptions() {
  const [numbers, settings] = await Promise.all([sendingNumbers(), loadSettings()]);
  return { numbers, secondaryNumberId: settings.secondary_quo_number_id || null };
}

async function doStart({ tokens, actorId, actorName, channelId, threadTs, source, responseUrl }) {
  const sequences = await activeSequences();
  const numbers = await sendingNumbers();
  const aliases = await sendingAliases();
  const parsed = parseStartArgs(tokens, {
    sequenceSlugs: sequences.map((sequence) => sequence.slug),
    sendingNumbers: numbers,
    aliases,
  });

  if (!parsed.phone) {
    return ephemeral(":warning: I need a mobile number. Try `/followup start 512-555-0123`, "
      + "or just `/followup` for the form.");
  }

  if (parsed.fromAsked && !parsed.quoNumberId) {
    return ephemeral(":warning: I could not match that sending number to a Quo line. Use the "
      + "name as it is labelled in Quo — `from Intake` — or run `/followup` and pick it on the form.");
  }

  const assignee = parsed.assignee ?? actorId;
  const result = await startSeries({
    phone: parsed.phone,
    language: parsed.language,
    first_name: parsed.firstName,
    sequence_slug: parsed.sequenceSlug,
    quo_number_id: parsed.quoNumberId ?? null,
    assigned_slack_user_id: assignee,
    assigned_slack_user_name: parsed.assignee ? await lookupSlackName(assignee) : actorName,
    started_by_slack_user_id: actorId,
    slack_channel_id: channelId,
    slack_thread_ts: threadTs ?? null,
    source,
  });

  if (!result?.ok) return ephemeral(enrollFailureText(result, parsed.phone));

  await announceEnrollment(result, { fallbackResponseUrl: responseUrl });

  // Slack sends no thread with a slash command — the payload has channel_id and
  // nothing else about where it was typed — so a series started this way always
  // confirms at the top of the channel. Run in a thread that reads as the
  // command doing nothing, so say where it went and how to keep it in the thread.
  if (source === "command") {
    return ephemeral(`:white_check_mark: Started for ${formatPhone(parsed.phone)}. The confirmation, `
      + "with the Stop button, is at the bottom of the channel rather than in this thread — Slack "
      + "does not tell a slash command which thread it was run in.\n"
      + "To keep everything in a thread, use `@sms-follow-up start "
      + `${formatPhone(parsed.phone)}\` in it instead, or the \`⋯\` menu on a message.`);
  }
  return null;
}

async function doStop({ tokens, operator }) {
  const { phone } = takePhone(tokens);
  if (!phone) return ephemeral(":warning: Which number? Try `/followup stop 512-555-0123`.");

  const result = await stopSeries({
    phone,
    actor: operator.slack_user_id,
    enforceAssignment: true,
  });

  if (!result?.ok) {
    if (result?.reason === "not_assigned") {
      return ephemeral(`:lock: That series is assigned to <@${result.assigned_slack_user_id}>, `
        + "so only they or a supervisor can stop it.");
    }
    if (result?.reason === "no_active_enrollment") {
      return ephemeral(`:information_source: Nothing is running for ${maskPhone(normalizePhone(phone) ?? phone)}.`);
    }
    if (result?.reason === "invalid_phone") {
      return ephemeral(`:warning: \`${phone}\` does not read as a mobile number.`);
    }
    return ephemeral(`:warning: The series could not be stopped (${result?.reason ?? "unknown"}).`);
  }

  await announceStop(result, `<@${operator.slack_user_id}>`);
  const sent = Number(result.sent_count ?? 0);
  return ephemeral(`:white_check_mark: Stopped. ${sent} text${sent === 1 ? "" : "s"} had gone out.`);
}

async function doStatus(tokens) {
  const { phone } = takePhone(tokens);
  if (!phone) return ephemeral(":warning: Which number? Try `/followup status 512-555-0123`.");

  const contacts = await rows(
    `select id, phone_e164, first_name, language, opted_out_at, last_inbound_at
     from followup_contacts where phone_e164 = $1 and ($2::uuid is null or firm_id = $2)`,
    [phone, currentFirm()?.id ?? null],
  );
  const contact = contacts[0];
  if (!contact) return ephemeral(`:information_source: No history for ${maskPhone(phone)}.`);

  const history = await rows(
    `select e.status, e.next_run_at, e.next_position, e.assigned_slack_user_id, e.started_at,
            q.name as sequence_name, q.timezone,
            (select count(*) from followup_messages m
             where m.enrollment_id = e.id and m.direction = 'outbound' and m.status <> 'failed') as sent
     from followup_enrollments e
     join followup_sequences q on q.id = e.sequence_id
     where e.contact_id = $1
     order by e.started_at desc limit 3`,
    [contact.id],
  );

  const shown = await displayPhone(contact.phone_e164);
  const lines = [
    `*${contact.first_name ?? "Client"}* — ${shown}`,
    `Language: ${contact.language === "es" ? "Spanish" : "English"}`,
  ];
  if (contact.opted_out_at) lines.push(":no_entry: *Opted out* — no texts can be sent.");
  if (contact.last_inbound_at) lines.push(`Last heard from them: ${formatWhen(contact.last_inbound_at)}`);

  for (const row of history) {
    const when = row.status === "active"
      ? `next text ${formatWhen(row.next_run_at, row.timezone)}`
      : `${row.status.replace(/_/g, " ")}`;
    lines.push(`• ${row.sequence_name} — ${when}, ${row.sent} sent, assigned to <@${row.assigned_slack_user_id}>`);
  }

  return ephemeral(lines.join("\n"));
}

async function doList(operator) {
  const params = [];
  let clause = "where e.status = 'active'";
  // Supervisors see the whole board; everyone else sees their own clients.
  if (!operator.is_supervisor) {
    params.push(operator.slack_user_id);
    clause += ` and e.assigned_slack_user_id = $1`;
  }

  const list = await rows(
    `select e.next_run_at, e.next_position, e.assigned_slack_user_id,
            c.phone_e164, c.first_name, q.name as sequence_name, q.timezone
     from followup_enrollments e
     join followup_contacts c on c.id = e.contact_id
     join followup_sequences q on q.id = e.sequence_id
     ${clause}
     order by e.next_run_at limit 40`,
    params,
  );

  if (!list.length) {
    return ephemeral(operator.is_supervisor
      ? ":information_source: No follow-up series are running right now."
      : ":information_source: You have no follow-up series running.");
  }

  const lines = await Promise.all(list.map(async (row) => {
    const who = row.first_name ?? await displayPhone(row.phone_e164);
    return `• *${who}* — ${row.sequence_name}, step ${row.next_position} `
      + `${formatWhen(row.next_run_at, row.timezone)}`
      + (operator.is_supervisor ? ` · <@${row.assigned_slack_user_id}>` : "");
  }));

  return ephemeral([
    operator.is_supervisor ? `*${list.length} series running*` : `*Your ${list.length} running series*`,
    ...lines,
  ].join("\n"));
}

async function openStartModal({ triggerId, userId, channelId, threadTs, sourceText }) {
  const sequences = await activeSequences();
  if (!sequences.length) {
    return { error: ":warning: No sequences are set up yet. Create one in the dashboard first." };
  }

  const phones = sourceText ? extractPhones(sourceText) : [];
  const opened = await slackApi("views.open", {
    trigger_id: triggerId,
    view: startModal({
      sequences,
      ...(await sendingOptions()),
      context: { channel_id: channelId ?? "", thread_ts: threadTs ?? "" },
      invokingUserId: userId,
      prefill: {
        phone: phones[0] ? formatPhone(phones[0]) : undefined,
        sourceText: sourceText ?? undefined,
      },
    }),
  });

  if (!opened.ok) return { error: null, failed: opened.error };
  return { ok: true };
}

/* --------------------------------------------------------- slash command */

slackRouter.post("/commands", async (req, res) => {
  const verified = await verifySlackRequest(req, req.rawBody, { teamId: req.body?.team_id });
  if (!verified.ok) {
    console.warn("Rejected a Slack command:", verified.reason);
    return res.status(401).send("Unauthorized");
  }

  return runWithFirm(verified.firm, async () => {

  const params = req.body;
  const userId = params.user_id ?? "";

  try {
    const operator = await loadOperator(userId);
    if (!operator) {
      return res.json(ephemeral(":lock: You are not set up to send client follow-ups. An "
        + `administrator can add you under Operators in the dashboard — your Slack ID is \`${userId}\`.`));
    }

    const tokens = String(params.text ?? "").trim().split(/\s+/).filter(Boolean);
    const verb = (tokens[0] ?? "").toLowerCase();
    const rest = tokens.slice(1);
    const common = {
      actorId: userId,
      actorName: params.user_name ?? null,
      channelId: params.channel_id ?? null,
      // A slash command carries no thread, so a series started this way threads
      // off its own confirmation message instead.
      threadTs: null,
      source: "command",
      responseUrl: params.response_url ?? null,
    };

    if (verb === "help") return res.json(ephemeral(HELP));
    if (verb === "list") return res.json(await doList(operator));
    if (verb === "status") return res.json(await doStatus(rest));
    if (verb === "stop") return res.json(await doStop({ tokens: rest, operator }));
    if (verb === "start") {
      const reply = await doStart({ ...common, tokens: rest });
      return reply ? res.json(reply) : res.status(200).send("");
    }

    if (!tokens.length) {
      if (slackBotToken() && params.trigger_id) {
        const opened = await openStartModal({
          triggerId: params.trigger_id,
          userId,
          channelId: params.channel_id,
        });
        if (opened.ok) return res.status(200).send("");
        if (opened.error) return res.json(ephemeral(opened.error));
      }
      return res.json(ephemeral(HELP));
    }

    // `/followup 512-555-0123 es Maria` — a bare number means start.
    if (takePhone(tokens).phone) {
      const reply = await doStart({ ...common, tokens });
      return reply ? res.json(reply) : res.status(200).send("");
    }

    return res.json(ephemeral(HELP));
  } catch (error) {
    console.error("slash command failed", error);
    return res.json(ephemeral(":warning: Something went wrong. The error has been logged."));
  }
  });
});

/* ------------------------------------------------------------ lead intake */

// The name Slack shows against an app's post. Different sources fill different
// fields, so try all of them before giving up.
function senderName(event) {
  return String(event.bot_profile?.name || event.username || event.app_id || event.bot_id || "").trim();
}

// Only a form fill counts, and the strongest available signal for that is who
// posted it. A person pasting a client's number into the channel is not a form
// fill, and this is the check that keeps the rest of the channel out.
function isFormFill(event, allowedNames) {
  // A human message has a user and no bot identity. Never read one.
  if (!event.bot_id && !event.app_id && event.subtype !== "bot_message") {
    return { ok: false, why: "posted by a person, not an app" };
  }
  if (!allowedNames.length) return { ok: true };

  const name = senderName(event).toLowerCase();
  const matched = allowedNames.some((allowed) => name === allowed || name.includes(allowed));
  return matched
    ? { ok: true }
    : { ok: false, why: `"${senderName(event) || "unnamed app"}" is not on the list of lead apps` };
}

// Every post the router considered, and what it concluded. In watch-and-record
// mode this is the only output; in live mode it is how a wrong route is
// understood afterwards. Written before anything is sent, so a crash mid-send
// still leaves a record of the decision.
async function recordObservation(fields) {
  const observation = await one(
    `insert into lead_observations (
       slack_channel_id, slack_ts, sender_name, sender_app_id, post_text, mode,
       phone_e164, email, is_lead, sequence_slug, sequence_name, classifier_slug, language,
       first_name, last_name, case_type, case_detail, lead_source, confidence, reasoning,
       classifier_error, preview_body, preview_segments, preview_is_night, preview_next_at,
       outcome, outcome_detail, enrollment_id
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
     on conflict (slack_channel_id, slack_ts) where slack_ts is not null do nothing
     returning *`,
    [
      fields.channel ?? null, fields.ts ?? null, fields.senderName ?? null, fields.appId ?? null,
      truncateChars(fields.text ?? "", 8000), fields.mode,
      fields.phone ?? null, fields.email ?? null, fields.isLead ?? null,
      fields.sequenceSlug ?? null, fields.sequenceName ?? null, fields.classifierSlug ?? null,
      fields.language ?? null,
      fields.firstName ?? null, fields.lastName ?? null, fields.caseType ?? null, fields.caseDetail ?? null,
      fields.leadSource ?? null, fields.confidence ?? null, fields.reasoning ?? null,
      fields.classifierError ?? null, fields.previewBody ?? null, fields.previewSegments ?? null,
      fields.previewIsNight ?? null, fields.previewNextAt ?? null,
      fields.outcome, fields.outcomeDetail ?? null, fields.enrollmentId ?? null,
    ],
  ).catch((error) => {
    console.error("could not record the lead observation", error);
    return null;
  });
  return observation;
}

export async function handleLeadPost(event) {
  const settings = await loadSettings();
  const channel = String(settings.lead_channel_id ?? "").trim();
  const mode = String(settings.lead_mode ?? "off");

  // If intake is off, say nothing — the app is in the channel for other reasons
  // and this would be noise on every message. Once it is on, though, every
  // message the bot can see is logged with the decision, so "is it even seeing
  // leads?" is answered by the deploy log and not only by the Leads page.
  const log = (outcome, extra = "") => {
    if (mode === "off") return;
    const where = event.channel === channel ? "" : ` in ${event.channel} (configured ${channel || "none"})`;
    console.log(`lead intake [${mode}]: ${outcome}${where} from ${senderName(event) || "a person"}${extra}`);
  };

  // The cheapest gates first, and the channel before anything reads the body.
  // The app is in other channels for its own reasons and must not read leads
  // out of them.
  if (mode === "off") return { ignored: "mode_off" };
  if (!channel) { log("skipped — no lead channel is set under Settings"); return { ignored: "no_channel" }; }
  if (event.channel !== channel) { log("skipped — different channel"); return { ignored: "other_channel" }; }

  // Our own posts, edits, deletions and thread replies are not new leads.
  if (event.subtype && event.subtype !== "bot_message") { log(`skipped — message subtype ${event.subtype}`); return { ignored: event.subtype }; }
  if (event.thread_ts && event.thread_ts !== event.ts) { log("skipped — a thread reply, not a new post"); return { ignored: "thread_reply" }; }
  if (event.app_id && event.app_id === slackAppId()) { log("skipped — our own post"); return { ignored: "self" }; }

  // Catch-up and Slack retries both redeliver the same ts. Skip before the
  // model runs, otherwise a reread costs a classification for a row that the
  // unique index would have dropped anyway.
  if (event.ts) {
    const seen = await one(
      "select id from lead_observations where slack_channel_id = $1 and slack_ts = $2",
      [event.channel, event.ts],
    );
    if (seen) return { ignored: "already_recorded" };
  }

  const allowed = String(settings.lead_senders ?? "")
    .split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
  const sender = isFormFill(event, allowed);

  const base = {
    channel: event.channel,
    ts: event.ts,
    senderName: senderName(event) || null,
    appId: event.app_id ?? null,
    mode,
  };

  if (!sender.ok) {
    // Recorded rather than dropped silently, so "why did it skip that one?" has
    // an answer on the Leads page.
    log(`skipped — ${sender.why}`);
    await recordObservation({
      ...base,
      text: flattenSlackMessage(event),
      outcome: "ignored_sender",
      outcomeDetail: sender.why,
    });
    return { ignored: "sender", detail: sender.why };
  }

  const assessment = await assessLeadPost(event);

  if (!assessment.act) {
    log(`read, not acted on — ${assessment.reason}`);
    await recordObservation({
      ...base,
      text: assessment.text ?? flattenSlackMessage(event),
      phone: assessment.phone ?? null,
      email: assessment.email ?? null,
      firstName: assessment.firstName ?? null,
      lastName: assessment.lastName ?? null,
      language: assessment.language ?? null,
      caseType: assessment.caseType ?? null,
      caseDetail: assessment.caseDetail ?? null,
      leadSource: assessment.leadSource ?? null,
      sequenceSlug: assessment.sequenceSlug ?? null,
      classifierSlug: assessment.classifierSlug ?? null,
      confidence: assessment.confidence ?? null,
      reasoning: assessment.reasoning ?? null,
      outcome: assessment.reason === "no_phone" ? "no_phone" : "not_a_lead",
      outcomeDetail: assessment.reason,
    });
    return { ignored: assessment.reason };
  }

  log(`recorded a lead${assessment.classifierFailed ? ` (routing fell back: ${assessment.classifierFailed})` : ""}`,
    ` → ${assessment.sequenceSlug ?? "default"} · ${assessment.confidence ?? "?"} confidence`);

  const sequence = assessment.sequenceSlug
    ? (await rows("select name from followup_sequences where slug = $1 and ($2::uuid is null or firm_id = $2)", [assessment.sequenceSlug, currentFirm()?.id ?? null]))[0]
    : (await rows("select name from followup_sequences where is_default and ($1::uuid is null or firm_id = $1) limit 1", [currentFirm()?.id ?? null]))[0];

  const preview = await previewFirstText(assessment.sequenceSlug, {
    firstName: assessment.firstName,
    lastName: assessment.lastName,
    caseType: assessment.caseType,
    language: assessment.language,
  });

  const observed = {
    ...base,
    text: assessment.text,
    phone: assessment.phone,
    email: assessment.email,
    isLead: true,
    sequenceSlug: assessment.sequenceSlug,
    sequenceName: sequence?.name ?? null,
    classifierSlug: assessment.classifierSlug ?? null,
    language: assessment.language,
    firstName: assessment.firstName,
    lastName: assessment.lastName,
    caseType: assessment.caseType,
    caseDetail: assessment.caseDetail,
    leadSource: assessment.leadSource,
    confidence: assessment.confidence,
    reasoning: assessment.reasoning,
    classifierError: assessment.classifierFailed ?? null,
    previewBody: preview?.body ?? null,
    previewSegments: preview?.segments ?? null,
    previewIsNight: preview?.isNight ?? null,
    previewNextAt: preview?.nextAt ?? null,
  };

  // Watch and record: decide, write it down, text nobody, post nothing.
  if (mode !== "live") {
    await recordObservation({ ...observed, outcome: "preview_only" });
    return { previewed: true };
  }

  const owner = String(settings.lead_default_owner_slack_id ?? "").trim();
  if (!owner) {
    await recordObservation({
      ...observed,
      outcome: "no_owner",
      outcomeDetail: "No default owner is set under Settings, so nothing was started.",
    });
    console.warn("A lead arrived but no default owner is set, so nothing was started.");
    return { ignored: "no_owner" };
  }

  const threadTs = event.thread_ts ?? event.ts;
  const result = await startSeries({
    phone: assessment.phone,
    language: assessment.language,
    first_name: assessment.firstName,
    last_name: assessment.lastName,
    case_type: assessment.caseType,
    sequence_slug: assessment.sequenceSlug,
    assigned_slack_user_id: owner,
    assigned_slack_user_name: await lookupSlackName(owner),
    started_by_slack_user_id: owner,
    slack_channel_id: event.channel,
    slack_thread_ts: threadTs,
    source: "lead",
    lead_source: assessment.leadSource,
    lead_detail: {
      confidence: assessment.confidence,
      reasoning: assessment.reasoning,
      case_type: assessment.caseType ?? null,
      case_detail: assessment.caseDetail ?? null,
      email: assessment.email ?? null,
      classifier_failed: assessment.classifierFailed ?? null,
    },
  });

  if (!result?.ok) {
    await recordObservation({
      ...observed,
      outcome: "enroll_failed",
      outcomeDetail: result?.reason ?? "unknown",
    });
    // Worth saying out loud in the thread: silence here looks like the
    // automation working, when in fact this lead is getting no texts.
    await slackApi("chat.postMessage", {
      channel: event.channel,
      thread_ts: threadTs,
      text: `:warning: No follow-ups started for this lead — ${enrollFailureText(result, assessment.phone)}`,
    });
    return { ignored: result?.reason ?? "enroll_failed" };
  }

  await recordObservation({ ...observed, outcome: "started", enrollmentId: result.enrollment_id });
  await announceEnrollment(result, {
    channel: event.channel,
    threadTs,
    routing: {
      confidence: assessment.confidence,
      reasoning: assessment.reasoning,
      caseType: assessment.caseType,
    },
  });

  return { started: true, enrollment_id: result.enrollment_id };
}


/* ------------------------------------------------------------- events API */

// Lets somebody start follow-ups by @mentioning the app inside an existing
// thread, which is where intake conversations actually happen.
slackRouter.post("/events", async (req, res) => {
  const verified = await verifySlackRequest(req, req.rawBody, { teamId: req.body?.team_id });
  if (!verified.ok) {
    console.warn("Rejected a Slack event:", verified.reason);
    return res.status(401).send("Unauthorized");
  }

  const body = req.body;
  if (body.type === "url_verification") return res.json({ challenge: body.challenge });

  // Slack retries anything not acknowledged within three seconds, so ack first
  // and do the work after.
  res.status(200).send("");

  const event = body.event;
  if (!event) return;

  return runWithFirm(verified.firm, async () => {

  // Lead posts come from other apps, so they arrive as ordinary channel
  // messages rather than mentions. handleLeadPost drops anything outside the
  // one configured channel before looking at it at all.
  if (event.type === "message") {
    await handleLeadPost(event).catch((error) => console.error("lead intake failed", error));
    return;
  }

  if (event.type !== "app_mention" || event.bot_id) return;

  try {
    const operator = await loadOperator(event.user);
    const threadTs = event.thread_ts ?? event.ts;

    if (!operator) {
      await slackApi("chat.postEphemeral", {
        channel: event.channel,
        user: event.user,
        thread_ts: threadTs,
        text: ":lock: You are not set up to send client follow-ups. An administrator can add you "
          + `under Operators in the dashboard — your Slack ID is \`${event.user}\`.`,
      });
      return;
    }

    // Drop the leading <@BOTID> mention, then treat the rest as shorthand.
    const withoutMention = String(event.text ?? "").replace(/<@[A-Z0-9]+>/g, " ").trim();
    let tokens = withoutMention.split(/\s+/).filter(Boolean);
    if ((tokens[0] ?? "").toLowerCase() === "start") tokens = tokens.slice(1);

    // Only the person who mistyped needs to see the correction, so it does not
    // clutter a thread everyone else is reading.
    const privately = (text) => slackApi("chat.postEphemeral", {
      channel: event.channel, user: event.user, thread_ts: threadTs, text,
    });

    const verb = (tokens[0] ?? "").toLowerCase();

    if (!tokens.length || verb === "help") {
      await slackApi("chat.postMessage", { channel: event.channel, thread_ts: threadTs, text: HELP });
      return;
    }

    if (verb === "stop") {
      const reply = await doStop({ tokens: tokens.slice(1), operator });
      await privately(reply.text);
      return;
    }

    // These two exist as slash commands, and without them here an unrecognised
    // first word fell through to start and became {{first_name}} — so
    // `@sms-follow-up status 512-555-0123` texted the client "Hi status,".
    if (verb === "status") {
      await privately((await doStatus(tokens.slice(1))).text);
      return;
    }
    if (verb === "list") {
      await privately((await doList(operator)).text);
      return;
    }

    // A word that was aiming at a verb and missed. Guessing here is what sends a
    // client a text addressed to "stauts", so ask instead — even when a usable
    // number is sitting right there.
    const meant = nearestVerb(tokens[0]);
    if (meant) {
      await privately(`:grey_question: Did you mean \`${meant}\`? I read \`${tokens[0]}\` and could `
        + `not place it.\n\n${MENTION_SYNTAX}`);
      return;
    }

    // If no number was typed, fall back to any number already in the thread's
    // parent message — usually exactly where the client's number is.
    if (!takePhone(tokens).phone && event.thread_ts) {
      const parent = await slackApi("conversations.replies", {
        channel: event.channel,
        ts: event.thread_ts,
        limit: 1,
      });
      const parentText = parent?.messages?.[0]?.text ?? "";
      const found = extractPhones(parentText);
      if (found[0]) tokens = [found[0], ...tokens];
    }

    // Still nothing phone-shaped, here or in the message above. Whatever was
    // typed, it was not a start, so show the syntax rather than the generic
    // "I need a number" — which used to answer with the slash-command form even
    // though they had just used the mention.
    if (!takePhone(tokens).phone) {
      await privately(`:grey_question: I could not find a mobile number in that.\n\n`
        + `${MENTION_SYNTAX}\n\n${MENTION_ORDER_NOTE}`);
      return;
    }

    const reply = await doStart({
      tokens,
      actorId: event.user,
      actorName: operator.display_name,
      channelId: event.channel,
      threadTs,
      source: "mention",
      responseUrl: null,
    });

    if (reply) {
      await slackApi("chat.postEphemeral", {
        channel: event.channel,
        user: event.user,
        thread_ts: threadTs,
        text: reply.text,
      });
    }
  } catch (error) {
    console.error("app_mention handling failed", error);
  }
  });
});

/* ---------------------------------------------------------- interactivity */

async function handleMessageShortcut(payload, res) {
  const operator = await loadOperator(payload.user.id);
  if (!operator) {
    await slackApi("views.open", {
      trigger_id: payload.trigger_id,
      view: {
        type: "modal",
        title: { type: "plain_text", text: "Not allowed" },
        close: { type: "plain_text", text: "Close" },
        blocks: [{
          type: "section",
          text: {
            type: "mrkdwn",
            text: ":lock: You are not set up to send client follow-ups. An administrator can add "
              + `you under Operators in the dashboard — your Slack ID is \`${payload.user.id}\`.`,
          },
        }],
      },
    });
    return res.status(200).send("");
  }

  const message = payload.message ?? {};
  const sourceText = message.text ?? "";
  const phones = extractPhones(sourceText);

  if (!phones.length) {
    await slackApi("views.open", { trigger_id: payload.trigger_id, view: noPhoneModal(sourceText) });
    return res.status(200).send("");
  }

  const sequences = await activeSequences();
  if (!sequences.length) {
    await slackApi("views.open", {
      trigger_id: payload.trigger_id,
      view: {
        type: "modal",
        title: { type: "plain_text", text: "No sequences" },
        close: { type: "plain_text", text: "Close" },
        blocks: [{
          type: "section",
          text: { type: "mrkdwn", text: ":warning: No sequences are set up yet. Create one in the dashboard first." },
        }],
      },
    });
    return res.status(200).send("");
  }

  await slackApi("views.open", {
    trigger_id: payload.trigger_id,
    view: startModal({
      sequences,
      ...(await sendingOptions()),
      // Anchor to the thread the message belongs to; a top-level message becomes
      // the start of its own thread.
      context: {
        channel_id: payload.channel?.id ?? "",
        thread_ts: message.thread_ts || message.ts || "",
      },
      invokingUserId: payload.user.id,
      prefill: { phone: formatPhone(phones[0]), sourceText },
    }),
  });
  return res.status(200).send("");
}

async function handleStopButton(payload, res) {
  const operator = await loadOperator(payload.user.id);
  const responseUrl = payload.response_url;

  if (!operator) {
    await respondToUrl(responseUrl, {
      response_type: "ephemeral",
      replace_original: false,
      text: ":lock: You are not set up to manage client follow-ups.",
    });
    return res.status(200).send("");
  }

  const result = await stopSeries({
    enrollmentId: payload.actions[0].value,
    actor: operator.slack_user_id,
    enforceAssignment: true,
  });

  if (!result?.ok) {
    const text = result?.reason === "not_assigned"
      ? `:lock: That series belongs to <@${result.assigned_slack_user_id}>, so only they or a supervisor can stop it.`
      : result?.reason === "not_active"
        ? ":information_source: That series has already stopped."
        : ":warning: The series could not be stopped.";
    await respondToUrl(responseUrl, { response_type: "ephemeral", replace_original: false, text });
    return res.status(200).send("");
  }

  const phone = await displayPhone(String(result.phone));
  const sent = Number(result.sent_count ?? 0);
  await respondToUrl(responseUrl, {
    replace_original: true,
    text: "Follow-ups stopped",
    blocks: [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:octagonal_sign: Follow-ups for ${phone} were stopped by <@${operator.slack_user_id}> `
          + `after ${sent} text${sent === 1 ? "" : "s"}.`,
      },
    }],
  });
  return res.status(200).send("");
}

async function handleModalSubmit(payload, res) {
  const operator = await loadOperator(payload.user.id);
  if (!operator) {
    return res.json({
      response_action: "errors",
      errors: { phone: "You are not set up to send client follow-ups." },
    });
  }

  const values = payload.view.state.values;
  const text = (block) => String(values?.[block]?.value?.value ?? "").trim();
  const selected = (block) => values?.[block]?.value?.selected_option?.value;

  let context = {};
  try {
    context = JSON.parse(payload.view.private_metadata || "{}");
  } catch { /* the form still works without a channel to announce in */ }

  const assignee = values?.assignee?.value?.selected_user ?? payload.user.id;
  const phone = text("phone");
  const sendFrom = selected("send_from");

  const result = await startSeries({
    phone,
    language: selected("language") ?? "en",
    first_name: text("first_name") || null,
    sequence_slug: selected("sequence"),
    quo_number_id: sendFrom && sendFrom !== "default" ? sendFrom : null,
    assigned_slack_user_id: assignee,
    assigned_slack_user_name: assignee === payload.user.id
      ? (operator.display_name ?? payload.user.name ?? null)
      : await lookupSlackName(assignee),
    started_by_slack_user_id: payload.user.id,
    slack_channel_id: context.channel_id || null,
    slack_thread_ts: context.thread_ts || null,
    source: context.thread_ts ? "message_action" : "command",
    case_reference: text("case_reference") || null,
  });

  // Field-level errors keep the form open with the number still typed in, which
  // is the difference between a two-second fix and starting over.
  if (!result?.ok) {
    const mapped = ENROLL_FIELD_ERRORS[result?.reason];
    return res.json({
      response_action: "errors",
      errors: mapped
        ? { [mapped.field]: mapped.text }
        : { phone: "The series could not be started. Try again." },
    });
  }

  res.status(200).send("");
  await announceEnrollment(result).catch((error) => console.error("announce failed", error));
  return undefined;
}

// Moving a lead the classifier put on the wrong track. Stops the current series
// and starts the chosen one for the same client, in the same thread — which is
// the correction worth making, and only useful before the second text.
async function handleReroute(payload, res) {
  const operator = await loadOperator(payload.user.id);
  const responseUrl = payload.response_url;
  const say = (text) => respondToUrl(responseUrl, {
    response_type: "ephemeral", replace_original: false, text,
  });

  if (!operator) {
    await say(":lock: You are not set up to manage client follow-ups.");
    return res.status(200).send("");
  }

  const [enrollmentId, slug] = String(payload.actions[0].selected_option?.value ?? "").split("|");
  if (!enrollmentId || !slug) {
    await say(":warning: That option could not be read.");
    return res.status(200).send("");
  }

  const current = await rows(
    `select e.id, e.slack_channel_id, e.slack_thread_ts, e.language, e.case_reference,
            e.lead_source, e.lead_detail, e.status, c.phone_e164, c.first_name, c.last_name
     from followup_enrollments e join followup_contacts c on c.id = e.contact_id
     where e.id = $1`,
    [enrollmentId],
  );
  const enrollment = current[0];
  if (!enrollment) {
    await say(":warning: That series no longer exists.");
    return res.status(200).send("");
  }

  if (enrollment.status === "active") {
    const stopped = await stopSeries({
      enrollmentId, actor: operator.slack_user_id, reason: "manual", enforceAssignment: true,
    });
    if (!stopped?.ok) {
      await say(stopped?.reason === "not_assigned"
        ? `:lock: That series belongs to <@${stopped.assigned_slack_user_id}>, so only they or a supervisor can move it.`
        : ":warning: The series could not be stopped, so it has not been moved.");
      return res.status(200).send("");
    }
    await retireStartCard(enrollmentId);
  }

  const started = await startSeries({
    phone: enrollment.phone_e164,
    language: enrollment.language,
    first_name: enrollment.first_name,
    last_name: enrollment.last_name,
    sequence_slug: slug,
    assigned_slack_user_id: operator.slack_user_id,
    assigned_slack_user_name: operator.display_name,
    started_by_slack_user_id: operator.slack_user_id,
    slack_channel_id: enrollment.slack_channel_id,
    slack_thread_ts: enrollment.slack_thread_ts,
    source: "lead",
    case_reference: enrollment.case_reference,
    lead_source: enrollment.lead_source,
    lead_detail: { ...(enrollment.lead_detail ?? {}), rerouted_by: operator.slack_user_id },
  });

  if (!started?.ok) {
    await say(`:warning: ${enrollFailureText(started, enrollment.phone_e164)}`);
    return res.status(200).send("");
  }

  await announceEnrollment(started);
  await say(`:white_check_mark: Moved to *${started.sequence?.name}*.`);
  return res.status(200).send("");
}

slackRouter.post("/interactivity", async (req, res) => {
  let teamId = req.body?.team_id;
  try {
    const preview = JSON.parse(req.body.payload || "{}");
    teamId = preview.team?.id || preview.team_id || teamId;
  } catch { /* signature check still runs on the raw body */ }

  const verified = await verifySlackRequest(req, req.rawBody, { teamId });
  if (!verified.ok) {
    console.warn("Rejected a Slack interaction:", verified.reason);
    return res.status(401).send("Unauthorized");
  }

  return runWithFirm(verified.firm, async () => {

  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch {
    return res.status(400).send("Bad payload");
  }

  try {
    if (payload.type === "message_action" && payload.callback_id === "start_followups") {
      return await handleMessageShortcut(payload, res);
    }
    if (payload.type === "view_submission" && payload.view?.callback_id === "followup_start") {
      return await handleModalSubmit(payload, res);
    }
    if (payload.type === "block_actions" && payload.actions?.[0]?.action_id === "followup_stop") {
      return await handleStopButton(payload, res);
    }
    if (payload.type === "block_actions" && payload.actions?.[0]?.action_id === "followup_reroute") {
      return await handleReroute(payload, res);
    }
    return res.status(200).send("");
  } catch (error) {
    console.error("interactivity failed", error);
    if (!res.headersSent) return res.status(200).send("");
    return undefined;
  }
  });
});
