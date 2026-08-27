import crypto from "node:crypto";
import { formatPhone, maskPhone } from "../../shared/messaging.js";
import { loadSettings } from "./settings.js";
import { currentFirm, listFirms, slackAppId, slackBotToken, slackSigningSecret } from "./firms.js";

/* ------------------------------------------------------------- signatures */

function signatureMatches(secret, signature, timestamp, rawBody) {
  if (!secret) return false;
  const computed = crypto.createHmac("sha256", secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest();
  const expected = signature.startsWith("v0=") ? signature.slice(3) : signature;
  if (!/^[0-9a-f]*$/i.test(expected) || expected.length !== computed.length * 2) return false;
  return crypto.timingSafeEqual(computed, Buffer.from(expected, "hex"));
}

function firmTeamId(firm) {
  return firm?.slack_team_id
    || (firm?.is_default ? process.env.SLACK_TEAM_ID : null)
    || null;
}

// v0=HMAC-SHA256 over `v0:<timestamp>:<raw body>`. Tries every firm's signing
// secret (and the env fallback on the default firm) so a second Slack workspace
// can share this endpoint. When more than one secret matches, the Slack app ID
// on the payload picks the firm — workspace ID alone is not enough, because
// people paste the Ramos James T0… onto the other firm while setting it up.
export async function verifySlackRequest(req, rawBody, { teamId, appId } = {}) {
  const signature = req.get("x-slack-signature");
  const timestamp = req.get("x-slack-request-timestamp");
  if (!signature || !timestamp) return { ok: false, reason: "Missing Slack signature headers." };

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return { ok: false, reason: "Slack request is too old." };

  const firms = await listFirms();
  const matched = firms.filter((firm) => signatureMatches(slackSigningSecret(firm), signature, timestamp, rawBody));
  if (!matched.length) {
    return {
      ok: false,
      reason: firms.some((firm) => slackSigningSecret(firm))
        ? "Slack signature did not match."
        : "SLACK_SIGNING_SECRET is not set.",
    };
  }

  const incomingApp = appId || req.body?.api_app_id || null;
  const incomingTeam = teamId || req.body?.team_id || null;
  const firm = pickFirm(matched, incomingApp, incomingTeam);
  console.log(
    `Slack request matched ${matched.map((row) => row.slug).join(",")} → ${firm.slug}`
    + (incomingApp ? ` app=${incomingApp}` : "")
    + (incomingTeam ? ` team=${incomingTeam}` : ""),
  );
  return { ok: true, firm };
}

function pickByTeam(firms, incomingTeam) {
  if (!incomingTeam) return null;
  return firms.find((row) => firmTeamId(row) === String(incomingTeam)) || null;
}

// Prefer the Slack app that actually sent the payload. Workspace ID is a
// fallback only, and a firm whose stored app ID disagrees with the payload is
// skipped so a second firm that was given Ramos James's T0… does not steal
// Ramos James events.
function pickFirm(matched, incomingApp, incomingTeam) {
  if (matched.length === 1) return matched[0];

  if (incomingApp) {
    const byApp = matched.find((row) => slackAppId(row) === String(incomingApp));
    if (byApp) return byApp;
    const remaining = matched.filter((row) => {
      const stored = slackAppId(row);
      return !stored || stored === String(incomingApp);
    });
    if (remaining.length === 1) return remaining[0];
    if (remaining.length > 1) return pickByTeam(remaining, incomingTeam) || remaining[0];
  }

  return pickByTeam(matched, incomingTeam) || matched[0];
}

/* ----------------------------------------------------------------- Web API */

export function slackConfigured() {
  return Boolean(slackBotToken());
}

const botUserIds = new Map();

export async function botUserId() {
  const token = slackBotToken();
  if (!token) return null;
  if (botUserIds.has(token)) return botUserIds.get(token);
  const result = await slackApi("auth.test");
  const id = result?.user_id ?? null;
  if (id) botUserIds.set(token, id);
  return id;
}

export function messageMentionsBot(event, userId) {
  if (!userId || !event?.text) return false;
  return String(event.text).includes(`<@${userId}>`);
}

// Overridable only so the end-to-end suite can point this at a stub and assert
// which channel and thread each message actually landed in. Nothing in a real
// deployment should set it.
const SLACK_API_BASE = (process.env.SLACK_API_BASE || "https://slack.com/api").replace(/\/$/, "");

export async function slackApi(method, payload) {
  const token = slackBotToken(currentFirm());
  if (!token) return { ok: false, error: "no_bot_token" };

  try {
    const response = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!body.ok) console.error(`slack ${method} failed:`, body.error);
    return body;
  } catch (error) {
    console.error(`slack ${method} threw`, error);
    return { ok: false, error: error.message };
  }
}

// Posts an update about a series. When the series was started from a message or
// inside a thread, this lands in that same thread, so everything about one
// client stays in one conversation instead of scattering across the channel.
export async function postToThread({ channel, threadTs, text, blocks }) {
  const settings = await loadSettings();
  const target = channel || settings.slack_alert_channel;
  if (!target) {
    console.warn("No Slack channel to post into; skipped:", text);
    return { ok: false, error: "no_channel" };
  }

  if (slackBotToken()) {
    return slackApi("chat.postMessage", {
      channel: target,
      text,
      ...(blocks ? { blocks } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    console.warn("No Slack destination configured; skipped:", text);
    return { ok: false, error: "no_destination" };
  }
  // An incoming webhook cannot thread, so this is a visible downgrade rather
  // than a silent one.
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...(blocks ? { blocks } : {}) }),
  }).catch((error) => console.error("Slack webhook failed", error));
  return { ok: true, degraded: true };
}

export async function respondToUrl(responseUrl, payload) {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((error) => console.error("Slack response_url failed", error));
}

/* ------------------------------------------------------------- formatting */

export async function displayPhone(phone) {
  const settings = await loadSettings();
  return settings.show_full_phone_in_slack ? phone : maskPhone(phone);
}

export function formatWhen(iso, timezone = "America/Chicago") {
  if (!iso) return "not scheduled";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

/* ----------------------------------------------------------------- blocks */

const CONFIDENCE_ICON = { high: ":large_green_circle:", medium: ":large_yellow_circle:", low: ":red_circle:" };

export function enrollmentBlocks(card) {
  const who = card.firstName ? `*${card.firstName}* ` : "";
  const language = card.language === "es" ? "Spanish" : "English";
  const actions = [{
    type: "button",
    action_id: "followup_stop",
    style: "danger",
    text: { type: "plain_text", text: "Stop follow-ups" },
    value: card.enrollmentId,
    confirm: {
      title: { type: "plain_text", text: "Stop follow-ups?" },
      text: { type: "mrkdwn", text: "No further texts will go out for this client." },
      confirm: { type: "plain_text", text: "Stop them" },
      deny: { type: "plain_text", text: "Keep going" },
    },
  }];

  if (card.rerouteOptions?.length) {
    actions.push({
      type: "static_select",
      action_id: "followup_reroute",
      placeholder: { type: "plain_text", text: "Wrong track? Move to…" },
      options: card.rerouteOptions,
    });
  }

  const routing = card.routing;
  const routingLine = routing
    ? `${CONFIDENCE_ICON[routing.confidence] ?? ":white_circle:"} Routed to *${card.sequenceName}*`
      + `${routing.caseType ? ` · ${routing.caseType}` : ""}`
      + ` · ${language}`
      + (routing.reasoning ? `\n_${routing.reasoning}_` : "")
    : null;

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:speech_balloon: Follow-up texts started for ${who}${card.phone}` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Sequence*\n${card.sequenceName}` },
        { type: "mrkdwn", text: `*Language*\n${language}` },
        { type: "mrkdwn", text: `*Assigned*\n<@${card.assignedUserId}>` },
        { type: "mrkdwn", text: `*First text*\n${formatWhen(card.nextRunAt, card.timezone)}` },
        { type: "mrkdwn", text: `*Texts queued*\n${card.stepCount}` },
        ...(card.fromNumber ? [{ type: "mrkdwn", text: `*Sending from*\n${card.fromNumber}` }] : []),
        ...(card.caseReference ? [{ type: "mrkdwn", text: `*Reference*\n${card.caseReference}` }] : []),
      ],
    },
    ...(routingLine ? [{
      type: "context",
      elements: [{ type: "mrkdwn", text: routingLine }],
    }] : []),
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: "Stops on its own if they reply or call back, or if they text STOP. "
          + "Replies land in this thread.",
      }],
    },
    { type: "actions", elements: actions },
  ];
}

// The start form. `context` carries the channel and thread this was launched
// from, so the confirmation and every later update go back to the same place.
export function startModal({ sequences, numbers = [], secondaryNumberId = null, context, invokingUserId, prefill = {} }) {
  const options = sequences.map((sequence) => ({
    text: { type: "plain_text", text: sequence.name.slice(0, 75) },
    value: sequence.slug,
  }));
  const defaultIndex = sequences.findIndex((sequence) => sequence.is_default);
  const initialSequence = options[defaultIndex >= 0 ? defaultIndex : 0];

  const languageOption = (value) => ({
    text: { type: "plain_text", text: value === "es" ? "Spanish" : "English" },
    value,
  });

  const blocks = [];

  if (prefill.sourceText) {
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `:thread: Starting from this message — updates will post in its thread.\n>${
          prefill.sourceText.slice(0, 280).replace(/\n/g, " ")
        }`,
      }],
    });
  }

  blocks.push(
    {
      type: "input",
      block_id: "phone",
      label: { type: "plain_text", text: "Mobile number" },
      ...(prefill.phone ? {} : { hint: { type: "plain_text", text: "Any format: 512-555-0123 works." } }),
      element: {
        type: "plain_text_input",
        action_id: "value",
        ...(prefill.phone ? { initial_value: prefill.phone } : {}),
        placeholder: { type: "plain_text", text: "(512) 555-0123" },
      },
    },
    {
      type: "input",
      block_id: "first_name",
      optional: true,
      label: { type: "plain_text", text: "First name" },
      hint: { type: "plain_text", text: "Used for {{first_name}} in the message copy." },
      element: {
        type: "plain_text_input",
        action_id: "value",
        ...(prefill.firstName ? { initial_value: prefill.firstName } : {}),
      },
    },
    {
      type: "input",
      block_id: "language",
      label: { type: "plain_text", text: "Language" },
      element: {
        type: "static_select",
        action_id: "value",
        initial_option: languageOption(prefill.language === "es" ? "es" : "en"),
        options: [languageOption("en"), languageOption("es")],
      },
    },
    {
      type: "input",
      block_id: "sequence",
      label: { type: "plain_text", text: "Sequence" },
      element: {
        type: "static_select",
        action_id: "value",
        ...(initialSequence ? { initial_option: initialSequence } : {}),
        options: options.length ? options : [
          { text: { type: "plain_text", text: "No sequences configured" }, value: "none" },
        ],
      },
    },
  );

  const activeNumbers = numbers.filter((number) => number.is_active);
  if (activeNumbers.length > 1) {
    const defaultOption = {
      text: { type: "plain_text", text: "Default number" },
      value: "default",
    };
    const numberOptions = [
      defaultOption,
      ...activeNumbers
        .slice()
        .sort((a, b) => {
          if (a.id === secondaryNumberId) return -1;
          if (b.id === secondaryNumberId) return 1;
          return 0;
        })
        .map((number) => {
          const shown = number.label
            ? `${number.label} — ${formatPhone(number.phone_e164) || number.phone_e164}`
            : (formatPhone(number.phone_e164) || number.phone_e164);
          return { text: { type: "plain_text", text: shown.slice(0, 75) }, value: number.id };
        }),
    ];
    blocks.push({
      type: "input",
      block_id: "send_from",
      optional: true,
      label: { type: "plain_text", text: "Send from" },
      hint: { type: "plain_text", text: "Leave as default unless this series should come from a different Quo line — pick it by the name shown in Quo." },
      element: {
        type: "static_select",
        action_id: "value",
        initial_option: defaultOption,
        options: numberOptions,
      },
    });
  }

  blocks.push(
    {
      type: "input",
      block_id: "assignee",
      label: { type: "plain_text", text: "Assigned to" },
      hint: { type: "plain_text", text: "Only this person, or a supervisor, can stop the series." },
      element: { type: "users_select", action_id: "value", initial_user: invokingUserId },
    },
    {
      type: "input",
      block_id: "case_reference",
      optional: true,
      label: { type: "plain_text", text: "Reference" },
      hint: { type: "plain_text", text: "Anything that helps you find this later." },
      element: {
        type: "plain_text_input",
        action_id: "value",
        ...(prefill.caseReference ? { initial_value: prefill.caseReference } : {}),
      },
    },
  );

  return {
    type: "modal",
    callback_id: "followup_start",
    private_metadata: JSON.stringify(context ?? {}),
    title: { type: "plain_text", text: "Start follow-ups" },
    submit: { type: "plain_text", text: "Start" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

// Shown when a message shortcut fires on a message with no readable number, so
// the paralegal is not left staring at a form that silently did nothing useful.
export function noPhoneModal(sourceText) {
  return {
    type: "modal",
    title: { type: "plain_text", text: "No number found" },
    close: { type: "plain_text", text: "Close" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "I could not find a mobile number in that message, so there is nothing to start "
            + "from. Run `/followup 512-555-0123` with the number instead.",
        },
      },
      ...(sourceText ? [{
        type: "context",
        elements: [{ type: "mrkdwn", text: `>${sourceText.slice(0, 280).replace(/\n/g, " ")}` }],
      }] : []),
    ],
  };
}
