// Slack request verification, Web API calls, and the message blocks the intake
// channel sees.
//
// Secrets:
//   SLACK_SIGNING_SECRET  required, verifies every inbound request
//   SLACK_BOT_TOKEN       optional; needed for the modal and for pushing updates
//                         into the channel when nobody typed a command
//   SLACK_WEBHOOK_URL     optional fallback for those pushes when there is no
//                         bot token
//   SLACK_ALERT_CHANNEL   optional default channel for unsolicited alerts

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function ephemeral(text: string, blocks?: unknown[]): Response {
  return json({ response_type: "ephemeral", text, ...(blocks ? { blocks } : {}) });
}

// ------------------------------------------------------------- signatures

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 ? `0${hex}` : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// v0=HMAC-SHA256 over `v0:<timestamp>:<raw body>`. The raw body matters: parsing
// and re-serializing the form would change the bytes and break the signature.
export async function verifySlackRequest(request: Request, rawBody: string): Promise<{ ok: boolean; reason?: string }> {
  const secret = Deno.env.get("SLACK_SIGNING_SECRET");
  if (!secret) return { ok: false, reason: "SLACK_SIGNING_SECRET is not configured." };

  const signature = request.headers.get("x-slack-signature");
  const timestamp = request.headers.get("x-slack-request-timestamp");
  if (!signature || !timestamp) return { ok: false, reason: "Missing Slack signature headers." };

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return { ok: false, reason: "Slack request is too old." };

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const computed = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`)),
  );

  const expected = signature.startsWith("v0=") ? signature.slice(3) : signature;
  if (!/^[0-9a-f]*$/i.test(expected)) return { ok: false, reason: "Malformed Slack signature." };

  return timingSafeEqual(computed, hexToBytes(expected))
    ? { ok: true }
    : { ok: false, reason: "Slack signature did not match." };
}

// --------------------------------------------------------------- Web API

export async function slackApi(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = Deno.env.get("SLACK_BOT_TOKEN");
  if (!token) return { ok: false, error: "no_bot_token" };

  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({ ok: false, error: "bad_json" }));
  if (!body.ok) console.error(`slack ${method} failed`, body.error);
  return body;
}

// Used when something happens with no command behind it: an inbound reply, a
// completed series, a send that gave up. Falls back to an incoming webhook when
// there is no bot token.
export async function notifyChannel(
  channel: string | null | undefined,
  text: string,
  blocks?: unknown[],
): Promise<void> {
  const target = channel || Deno.env.get("SLACK_ALERT_CHANNEL");
  if (Deno.env.get("SLACK_BOT_TOKEN") && target) {
    await slackApi("chat.postMessage", { channel: target, text, ...(blocks ? { blocks } : {}) });
    return;
  }

  const webhook = Deno.env.get("SLACK_WEBHOOK_URL");
  if (!webhook) {
    console.warn("No Slack destination configured; skipped notification:", text);
    return;
  }
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...(blocks ? { blocks } : {}) }),
  }).catch((error) => console.error("Slack webhook failed", error));
}

export async function respondToUrl(responseUrl: string, payload: Record<string, unknown>): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((error) => console.error("Slack response_url failed", error));
}

// ---------------------------------------------------------------- blocks

export function maskPhone(phone: string): string {
  // Intake channels are wide; showing the last four is enough to recognise a
  // client without putting the full number in front of everyone.
  if (!phone || phone.length < 4) return phone ?? "";
  return `(•••) •••-${phone.slice(-4)}`;
}

export function formatWhen(iso: string | null | undefined, timezone = "America/Chicago"): string {
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
    return iso;
  }
}

export interface EnrollmentCard {
  enrollmentId: string;
  phone: string;
  firstName?: string | null;
  language: string;
  sequenceName: string;
  stepCount: number;
  nextRunAt: string | null;
  assignedUserId: string;
  caseReference?: string | null;
  timezone?: string;
  showFullPhone?: boolean;
}

export function enrollmentBlocks(card: EnrollmentCard): unknown[] {
  const who = card.firstName ? `*${card.firstName}* ` : "";
  const phone = card.showFullPhone ? card.phone : maskPhone(card.phone);
  const language = card.language === "es" ? "Spanish" : "English";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:speech_balloon: Follow-ups started for ${who}${phone}`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Sequence*\n${card.sequenceName}` },
        { type: "mrkdwn", text: `*Language*\n${language}` },
        { type: "mrkdwn", text: `*Assigned*\n<@${card.assignedUserId}>` },
        { type: "mrkdwn", text: `*First text*\n${formatWhen(card.nextRunAt, card.timezone)}` },
        { type: "mrkdwn", text: `*Texts queued*\n${card.stepCount}` },
        ...(card.caseReference ? [{ type: "mrkdwn", text: `*Case*\n${card.caseReference}` }] : []),
      ],
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: "Stops on its own if they reply or call back, or if they text STOP.",
      }],
    },
    {
      type: "actions",
      elements: [{
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
      }],
    },
  ];
}

export function startModal(
  sequences: Array<{ slug: string; name: string; is_default: boolean }>,
  channelId: string,
  invokingUserId: string,
): Record<string, unknown> {
  const options = sequences.map((sequence) => ({
    text: { type: "plain_text", text: sequence.name.slice(0, 75) },
    value: sequence.slug,
  }));
  const defaultIndex = sequences.findIndex((sequence) => sequence.is_default);
  const initial = options[defaultIndex >= 0 ? defaultIndex : 0];

  return {
    type: "modal",
    callback_id: "followup_start",
    private_metadata: JSON.stringify({ channel_id: channelId }),
    title: { type: "plain_text", text: "Start follow-ups" },
    submit: { type: "plain_text", text: "Start" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "phone",
        label: { type: "plain_text", text: "Mobile number" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          placeholder: { type: "plain_text", text: "(512) 555-0123" },
        },
      },
      {
        type: "input",
        block_id: "first_name",
        optional: true,
        label: { type: "plain_text", text: "First name" },
        hint: { type: "plain_text", text: "Used for {{first_name}} in the message copy." },
        element: { type: "plain_text_input", action_id: "value" },
      },
      {
        type: "input",
        block_id: "language",
        label: { type: "plain_text", text: "Language" },
        element: {
          type: "static_select",
          action_id: "value",
          initial_option: { text: { type: "plain_text", text: "English" }, value: "en" },
          options: [
            { text: { type: "plain_text", text: "English" }, value: "en" },
            { text: { type: "plain_text", text: "Spanish" }, value: "es" },
          ],
        },
      },
      {
        type: "input",
        block_id: "sequence",
        label: { type: "plain_text", text: "Sequence" },
        element: {
          type: "static_select",
          action_id: "value",
          ...(initial ? { initial_option: initial } : {}),
          options: options.length ? options : [
            { text: { type: "plain_text", text: "No sequences configured" }, value: "none" },
          ],
        },
      },
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
        label: { type: "plain_text", text: "Case reference" },
        element: { type: "plain_text_input", action_id: "value" },
      },
    ],
  };
}
