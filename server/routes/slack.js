import express from "express";
import { extractPhones, formatPhone, maskPhone, normalizePhone } from "../../shared/messaging.js";
import { rows, rpc } from "../db.js";
import {
  activeSequences,
  announceEnrollment,
  announceStop,
  ENROLL_FIELD_ERRORS,
  enrollFailureText,
  loadOperator,
  lookupSlackName,
  startSeries,
  stopSeries,
} from "../lib/followups.js";
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
    + "number, `en`/`es` sets the language, a sequence name picks the sequence, an `@mention` "
    + "assigns it, and whatever is left is the first name. Leave the language out and it uses "
    + "whatever you last used for that number; leave the name out and the text says \"there\".",
  "",
  "A series stops on its own when the client replies, calls back, or texts STOP — `stop` is "
    + "for when they re-engage somewhere this cannot see.",
].join("\n");

/* ------------------------------------------------------------ arg parsing */

const LANGUAGE_WORDS = {
  en: "en", eng: "en", english: "en", ingles: "en",
  es: "es", spa: "es", spanish: "es", espanol: "es", "español": "es",
};

// A phone number is pulled out of the whole argument string rather than
// token-by-token, because people paste "(512) 555-0123" — three tokens, none of
// which is a phone number on its own.
function takePhone(tokens) {
  const text = tokens.join(" ");
  const phones = extractPhones(text);
  if (!phones.length) return { phone: null, rest: tokens };

  // Slack rewrites a typed number as <tel:+15125550123|(512) 555-0123>, which
  // contains a space and so survives tokenising as two fragments. Strip the
  // whole markup first, then drop any bare token that is only digits and phone
  // punctuation. Otherwise the leftovers become the client's first name, and
  // "<tel:+1512..." ends up merged into the text they receive.
  const rest = text
    .replace(/<tel:[^>]*>/gi, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !(/\d/.test(token) && /^[+()\-.\d]+$/.test(token)));

  return { phone: phones[0], rest };
}

function parseArgs(tokens, sequenceSlugs) {
  const parsed = {};
  const leftovers = [];

  const taken = takePhone(tokens);
  if (taken.phone) parsed.phone = taken.phone;

  for (const token of taken.rest) {
    // Slack sends escaped mentions as <@U123ABC|name> when link escaping is on.
    // With it off the text is a bare @name, which carries no ID to assign to, so
    // those fall through and are treated as part of the name.
    const mention = token.match(/^<@([A-Z0-9]+)(\|[^>]*)?>$/);
    if (mention) { parsed.assignee = mention[1]; continue; }

    const lower = token.toLowerCase();
    if (!parsed.language && lower in LANGUAGE_WORDS) { parsed.language = LANGUAGE_WORDS[lower]; continue; }
    if (!parsed.sequenceSlug && sequenceSlugs.includes(lower)) { parsed.sequenceSlug = lower; continue; }
    leftovers.push(token);
  }

  // A stray run of digits that did not parse as a phone is more likely a
  // mistyped number than a name, so keep it out of {{first_name}}.
  const nameParts = leftovers.filter((token) => !/^[0-9+()\-.]+$/.test(token));
  if (nameParts.length) parsed.firstName = nameParts.join(" ");
  return parsed;
}

/* ---------------------------------------------------------------- actions */

async function doStart({ tokens, actorId, actorName, channelId, threadTs, source, responseUrl }) {
  const sequences = await activeSequences();
  const parsed = parseArgs(tokens, sequences.map((sequence) => sequence.slug));

  if (!parsed.phone) {
    return ephemeral(":warning: I need a mobile number. Try `/followup start 512-555-0123`, "
      + "or just `/followup` for the form.");
  }

  const assignee = parsed.assignee ?? actorId;
  const result = await startSeries({
    phone: parsed.phone,
    language: parsed.language,
    first_name: parsed.firstName,
    sequence_slug: parsed.sequenceSlug,
    assigned_slack_user_id: assignee,
    assigned_slack_user_name: parsed.assignee ? await lookupSlackName(assignee) : actorName,
    started_by_slack_user_id: actorId,
    slack_channel_id: channelId,
    slack_thread_ts: threadTs ?? null,
    source,
  });

  if (!result?.ok) return ephemeral(enrollFailureText(result, parsed.phone));

  await announceEnrollment(result, { fallbackResponseUrl: responseUrl });
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
     from followup_contacts where phone_e164 = $1`,
    [phone],
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
  const verified = verifySlackRequest(req, req.rawBody);
  if (!verified.ok) {
    console.warn("Rejected a Slack command:", verified.reason);
    return res.status(401).send("Unauthorized");
  }

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
      if (process.env.SLACK_BOT_TOKEN && params.trigger_id) {
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

/* ------------------------------------------------------------- events API */

// Lets somebody start follow-ups by @mentioning the app inside an existing
// thread, which is where intake conversations actually happen.
slackRouter.post("/events", async (req, res) => {
  const verified = verifySlackRequest(req, req.rawBody);
  if (!verified.ok) return res.status(401).send("Unauthorized");

  const body = req.body;
  if (body.type === "url_verification") return res.json({ challenge: body.challenge });

  // Slack retries anything not acknowledged within three seconds, so ack first
  // and do the work after.
  res.status(200).send("");

  const event = body.event;
  if (!event || event.type !== "app_mention" || event.bot_id) return;

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

    if (!tokens.length || (tokens[0] ?? "").toLowerCase() === "help") {
      await slackApi("chat.postMessage", { channel: event.channel, thread_ts: threadTs, text: HELP });
      return;
    }

    if ((tokens[0] ?? "").toLowerCase() === "stop") {
      const reply = await doStop({ tokens: tokens.slice(1), operator });
      await slackApi("chat.postMessage", { channel: event.channel, thread_ts: threadTs, text: reply.text });
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

  const result = await startSeries({
    phone,
    language: selected("language") ?? "en",
    first_name: text("first_name") || null,
    sequence_slug: selected("sequence"),
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

slackRouter.post("/interactivity", async (req, res) => {
  const verified = verifySlackRequest(req, req.rawBody);
  if (!verified.ok) {
    console.warn("Rejected a Slack interaction:", verified.reason);
    return res.status(401).send("Unauthorized");
  }

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
    return res.status(200).send("");
  } catch (error) {
    console.error("interactivity failed", error);
    if (!res.headersSent) return res.status(200).send("");
    return undefined;
  }
});
