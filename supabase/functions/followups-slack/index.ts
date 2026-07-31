// The Slack side of the follow-up system: the slash command, the start modal,
// and the Stop button.
//
// Deploy without the JWT gate, because Slack signs its own requests:
//   supabase functions deploy followups-slack --no-verify-jwt
//
// Point both the slash command Request URL and the Interactivity Request URL at
// this function.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  enrollmentBlocks,
  ephemeral,
  formatWhen,
  json,
  maskPhone,
  notifyChannel,
  respondToUrl,
  slackApi,
  startModal,
  verifySlackRequest,
} from "../_shared/slack.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const SHOW_FULL_PHONE = (Deno.env.get("SLACK_SHOW_FULL_PHONE") ?? "false") === "true";

const HELP = [
  "*Client follow-up texts*",
  "",
  "`/followup` — open the start form (the easiest way in)",
  "`/followup start 512-555-0123 es Maria` — start without the form",
  "`/followup stop 512-555-0123` — stop a series you own",
  "`/followup status 512-555-0123` — where a client is in their series",
  "`/followup list` — everything you have running",
  "",
  "In the shorthand, order does not matter: anything that looks like a phone "
    + "number is the number, `en`/`es` sets the language, a sequence name sets the "
    + "sequence, and whatever is left is the first name. The series is assigned to "
    + "you unless you `@mention` someone else.",
  "",
  "A series stops on its own when the client replies, calls back, or texts STOP.",
].join("\n");

interface Operator {
  slack_user_id: string;
  display_name: string | null;
  is_supervisor: boolean;
}

async function loadOperator(userId: string): Promise<Operator | null> {
  const { data } = await supabase
    .from("followup_operators")
    .select("slack_user_id, display_name, is_supervisor")
    .eq("slack_user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  return data ?? null;
}

interface SequenceRow {
  slug: string;
  name: string;
  is_default: boolean;
  timezone: string;
}

async function loadSequences(): Promise<SequenceRow[]> {
  const { data } = await supabase
    .from("followup_sequences")
    .select("slug, name, is_default, timezone")
    .eq("is_active", true)
    .order("is_default", { ascending: false })
    .order("name");
  return (data ?? []) as SequenceRow[];
}

// ------------------------------------------------------------ arg parsing

const LANGUAGE_WORDS: Record<string, "en" | "es"> = {
  en: "en", eng: "en", english: "en", ingles: "en",
  es: "es", spa: "es", spanish: "es", espanol: "es", "español": "es",
};

interface ParsedArgs {
  phone?: string;
  language?: "en" | "es";
  sequenceSlug?: string;
  firstName?: string;
  assignee?: string;
}

function looksLikePhone(token: string): boolean {
  const digits = token.replace(/[^0-9]/g, "");
  return digits.length >= 10 && digits.length <= 15 && /^[+(]?[0-9()\-.\s]+$/.test(token);
}

function parseArgs(tokens: string[], sequenceSlugs: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  const leftovers: string[] = [];

  for (const token of tokens) {
    // Slack sends escaped mentions as <@U123ABC|name> when the app has link
    // escaping on. When it is off the text is a bare @name, which carries no id
    // we can assign to, so those fall through to the name.
    const mention = token.match(/^<@([A-Z0-9]+)(\|[^>]*)?>$/);
    if (mention) { parsed.assignee = mention[1]; continue; }

    const lower = token.toLowerCase();
    if (!parsed.language && lower in LANGUAGE_WORDS) { parsed.language = LANGUAGE_WORDS[lower]; continue; }
    if (!parsed.sequenceSlug && sequenceSlugs.includes(lower)) { parsed.sequenceSlug = lower; continue; }
    if (!parsed.phone && looksLikePhone(token)) { parsed.phone = token; continue; }
    leftovers.push(token);
  }

  // A bare run of digits that did not parse as a phone is more likely a
  // mistyped number than a name, so keep it out of {{first_name}}.
  const nameParts = leftovers.filter((token) => !/^[0-9+()\-.]+$/.test(token));
  if (nameParts.length) parsed.firstName = nameParts.join(" ");
  return parsed;
}

// --------------------------------------------------------------- commands

function enrollFailureText(result: Record<string, unknown>, phone: string): string {
  switch (result.reason) {
    case "invalid_phone":
      return `:warning: \`${phone}\` does not read as a mobile number. Try it as 512-555-0123.`;
    case "already_active":
      return `:information_source: ${maskPhone(phone)} already has a series running, `
        + `assigned to <@${result.assigned_slack_user_id}>. Stop that one first if you want to restart it.`;
    case "opted_out":
      return `:no_entry: ${maskPhone(phone)} has opted out of texts, so no series can be started. `
        + "They would need to text START themselves to opt back in.";
    case "sequence_not_found":
      return ":warning: I could not find that sequence. Run `/followup` to pick from the list.";
    case "sequence_inactive":
      return ":warning: That sequence is paused. Turn it back on in the admin area first.";
    case "no_steps":
      return ":warning: That sequence has no texts in it yet.";
    case "missing_assignee":
      return ":warning: Every series needs somebody assigned to it.";
    default:
      return `:warning: The series could not be started (${result.reason ?? "unknown error"}).`;
  }
}

async function announceEnrollment(
  result: Record<string, unknown>,
  channelId: string,
  timezone: string,
  fallbackToResponseUrl: string | null,
) {
  const blocks = enrollmentBlocks({
    enrollmentId: String(result.enrollment_id),
    phone: String(result.phone),
    firstName: (result.first_name as string) ?? null,
    language: String(result.language),
    sequenceName: String((result.sequence as Record<string, unknown>)?.name ?? "Follow-ups"),
    stepCount: Number(result.step_count ?? 0),
    nextRunAt: (result.next_run_at as string) ?? null,
    assignedUserId: String(result.assigned_slack_user_id),
    caseReference: (result.case_reference as string) ?? null,
    timezone,
    showFullPhone: SHOW_FULL_PHONE,
  });
  const text = `Follow-ups started for ${SHOW_FULL_PHONE ? result.phone : maskPhone(String(result.phone))}`;

  if (Deno.env.get("SLACK_BOT_TOKEN") && channelId) {
    const posted = await slackApi("chat.postMessage", { channel: channelId, text, blocks });
    if (posted.ok && posted.ts) {
      await supabase
        .from("followup_enrollments")
        .update({ slack_message_ts: String(posted.ts) })
        .eq("id", result.enrollment_id);
      return;
    }
  }

  if (fallbackToResponseUrl) {
    await respondToUrl(fallbackToResponseUrl, { response_type: "in_channel", text, blocks });
    return;
  }
  await notifyChannel(channelId, text, blocks);
}

async function handleStart(params: URLSearchParams, operator: Operator, tokens: string[]): Promise<Response> {
  const sequences = await loadSequences();
  const parsed = parseArgs(tokens, sequences.map((sequence) => sequence.slug));

  if (!parsed.phone) {
    return ephemeral(
      ":warning: I need a mobile number. Try `/followup start 512-555-0123`, or just `/followup` for the form.",
    );
  }

  const assignee = parsed.assignee ?? params.get("user_id") ?? "";
  const { data, error } = await supabase.rpc("followup_enroll", {
    payload: {
      phone: parsed.phone,
      language: parsed.language,
      first_name: parsed.firstName,
      sequence_slug: parsed.sequenceSlug,
      assigned_slack_user_id: assignee,
      assigned_slack_user_name: parsed.assignee ? null : params.get("user_name"),
      started_by_slack_user_id: params.get("user_id"),
      slack_channel_id: params.get("channel_id"),
    },
  });

  if (error) {
    console.error("followup_enroll failed", error);
    return ephemeral(":warning: Something went wrong starting the series. Try again in a moment.");
  }
  if (!data?.ok) return ephemeral(enrollFailureText(data, parsed.phone));

  const timezone = sequences.find((sequence) => sequence.slug === data.sequence?.slug)?.timezone
    ?? "America/Chicago";
  await announceEnrollment(data, params.get("channel_id") ?? "", timezone, params.get("response_url"));
  return new Response("", { status: 200 });
}

async function handleStop(params: URLSearchParams, operator: Operator, tokens: string[]): Promise<Response> {
  const phone = tokens.find(looksLikePhone);
  if (!phone) return ephemeral(":warning: Which number? Try `/followup stop 512-555-0123`.");

  const { data, error } = await supabase.rpc("followup_stop", {
    payload: {
      phone,
      reason: "manual",
      actor: operator.slack_user_id,
      enforce_assignment: true,
    },
  });
  if (error) {
    console.error("followup_stop failed", error);
    return ephemeral(":warning: Something went wrong stopping the series.");
  }

  if (!data?.ok) {
    if (data?.reason === "not_assigned") {
      return ephemeral(
        `:lock: That series is assigned to <@${data.assigned_slack_user_id}>, so only they `
          + "or a supervisor can stop it.",
      );
    }
    if (data?.reason === "no_active_enrollment") {
      return ephemeral(`:information_source: Nothing is running for ${maskPhone(phone)}.`);
    }
    if (data?.reason === "invalid_phone") {
      return ephemeral(`:warning: \`${phone}\` does not read as a mobile number.`);
    }
    return ephemeral(`:warning: The series could not be stopped (${data?.reason ?? "unknown"}).`);
  }

  const sent = Number(data.sent_count ?? 0);
  await notifyChannel(
    data.slack_channel_id as string,
    `:octagonal_sign: <@${operator.slack_user_id}> stopped follow-ups for `
      + `${SHOW_FULL_PHONE ? data.phone : maskPhone(String(data.phone))} after ${sent} `
      + `text${sent === 1 ? "" : "s"}.`,
  );
  return ephemeral(`:white_check_mark: Stopped. ${sent} text${sent === 1 ? "" : "s"} had gone out.`);
}

async function handleStatus(tokens: string[]): Promise<Response> {
  const phone = tokens.find(looksLikePhone);
  if (!phone) return ephemeral(":warning: Which number? Try `/followup status 512-555-0123`.");

  const { data: normalized } = await supabase.rpc("followup_normalize_phone", { raw: phone });
  if (!normalized) return ephemeral(`:warning: \`${phone}\` does not read as a mobile number.`);

  const { data: contact } = await supabase
    .from("followup_contacts")
    .select("id, phone_e164, first_name, language, opted_out_at, last_inbound_at")
    .eq("phone_e164", normalized)
    .maybeSingle();

  if (!contact) return ephemeral(`:information_source: No history for ${maskPhone(String(normalized))}.`);

  const { data: enrollments } = await supabase
    .from("followup_enrollments")
    .select("id, status, next_run_at, next_position, assigned_slack_user_id, started_at, "
      + "followup_sequences(name, timezone)")
    .eq("contact_id", contact.id)
    .order("started_at", { ascending: false })
    .limit(3);

  const { count: sentCount } = await supabase
    .from("followup_messages")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contact.id)
    .eq("direction", "outbound");

  const lines = [
    `*${contact.first_name ?? "Client"}* — ${SHOW_FULL_PHONE ? contact.phone_e164 : maskPhone(contact.phone_e164)}`,
    `Language: ${contact.language === "es" ? "Spanish" : "English"} · Texts sent: ${sentCount ?? 0}`,
  ];
  if (contact.opted_out_at) lines.push(":no_entry: *Opted out* — no texts can be sent.");
  if (contact.last_inbound_at) lines.push(`Last heard from them: ${formatWhen(contact.last_inbound_at)}`);

  for (const enrollment of enrollments ?? []) {
    const sequence = enrollment.followup_sequences as unknown as { name: string; timezone: string } | null;
    const when = enrollment.status === "active"
      ? `next text ${formatWhen(enrollment.next_run_at, sequence?.timezone)}`
      : `ended ${enrollment.status.replace("stopped_", "stopped on ").replace("_", " ")}`;
    lines.push(`• ${sequence?.name ?? "Series"} — ${enrollment.status} (${when}), `
      + `assigned to <@${enrollment.assigned_slack_user_id}>`);
  }

  return ephemeral(lines.join("\n"));
}

async function handleList(operator: Operator): Promise<Response> {
  let query = supabase
    .from("followup_enrollments")
    .select("id, next_run_at, next_position, assigned_slack_user_id, case_reference, "
      + "followup_contacts(phone_e164, first_name), followup_sequences(name, timezone)")
    .eq("status", "active")
    .order("next_run_at");

  // Supervisors see the whole board; everyone else sees their own clients.
  if (!operator.is_supervisor) query = query.eq("assigned_slack_user_id", operator.slack_user_id);

  const { data: rows, error } = await query.limit(40);
  const data = (rows ?? []) as Array<{
    id: string;
    next_run_at: string | null;
    next_position: number;
    assigned_slack_user_id: string;
    case_reference: string | null;
    followup_contacts: { phone_e164: string; first_name: string | null } | null;
    followup_sequences: { name: string; timezone: string } | null;
  }>;

  if (error) {
    console.error("list failed", error);
    return ephemeral(":warning: Could not load the list.");
  }
  if (!data.length) {
    return ephemeral(operator.is_supervisor
      ? ":information_source: No follow-up series are running right now."
      : ":information_source: You have no follow-up series running.");
  }

  const lines = data.map((enrollment) => {
    const contact = enrollment.followup_contacts;
    const sequence = enrollment.followup_sequences;
    const who = contact?.first_name ?? (SHOW_FULL_PHONE ? contact?.phone_e164 : maskPhone(contact?.phone_e164 ?? ""));
    return `• *${who}* — ${sequence?.name ?? "Series"}, step ${enrollment.next_position} `
      + `${formatWhen(enrollment.next_run_at, sequence?.timezone)}`
      + (operator.is_supervisor ? ` · <@${enrollment.assigned_slack_user_id}>` : "");
  });

  return ephemeral([
    operator.is_supervisor ? `*${data.length} series running*` : `*Your ${data.length} running series*`,
    ...lines,
  ].join("\n"));
}

async function handleCommand(params: URLSearchParams): Promise<Response> {
  const userId = params.get("user_id") ?? "";
  const operator = await loadOperator(userId);
  if (!operator) {
    return ephemeral(
      ":lock: You are not set up to send client follow-ups. An administrator can add you "
        + `under Operators in the follow-up admin area — your Slack ID is \`${userId}\`.`,
    );
  }

  const tokens = (params.get("text") ?? "").trim().split(/\s+/).filter(Boolean);
  const verb = (tokens[0] ?? "").toLowerCase();
  const rest = tokens.slice(1);

  if (verb === "help") return ephemeral(HELP);
  if (verb === "list") return handleList(operator);
  if (verb === "status") return handleStatus(rest);
  if (verb === "stop") return handleStop(params, operator, rest);
  if (verb === "start") return handleStart(params, operator, rest);

  // No verb at all: open the form when we can, otherwise fall back to the
  // shorthand if they typed a number, otherwise show help.
  if (!tokens.length || !verb) {
    const triggerId = params.get("trigger_id");
    if (Deno.env.get("SLACK_BOT_TOKEN") && triggerId) {
      const sequences = await loadSequences();
      if (!sequences.length) {
        return ephemeral(":warning: No sequences are set up yet. Create one in the admin area first.");
      }
      const opened = await slackApi("views.open", {
        trigger_id: triggerId,
        view: startModal(sequences, params.get("channel_id") ?? "", userId),
      });
      if (opened.ok) return new Response("", { status: 200 });
      console.error("views.open failed", opened.error);
    }
    return ephemeral(HELP);
  }

  // `/followup 512-555-0123 es Maria` — treat a bare number as a start.
  if (looksLikePhone(verb)) return handleStart(params, operator, tokens);
  return ephemeral(HELP);
}

// ---------------------------------------------------------- interactivity

async function handleStopButton(payload: Record<string, unknown>): Promise<Response> {
  const user = payload.user as { id: string };
  const action = (payload.actions as Array<{ value: string }>)[0];
  const responseUrl = payload.response_url as string;

  const operator = await loadOperator(user.id);
  if (!operator) {
    await respondToUrl(responseUrl, {
      response_type: "ephemeral",
      replace_original: false,
      text: ":lock: You are not set up to manage client follow-ups.",
    });
    return new Response("", { status: 200 });
  }

  const { data, error } = await supabase.rpc("followup_stop", {
    payload: {
      enrollment_id: action.value,
      reason: "manual",
      actor: operator.slack_user_id,
      enforce_assignment: true,
    },
  });

  if (error || !data?.ok) {
    const reason = data?.reason === "not_assigned"
      ? `:lock: That series belongs to <@${data.assigned_slack_user_id}>, so only they or a supervisor can stop it.`
      : data?.reason === "not_active"
      ? ":information_source: That series has already stopped."
      : ":warning: The series could not be stopped.";
    await respondToUrl(responseUrl, { response_type: "ephemeral", replace_original: false, text: reason });
    return new Response("", { status: 200 });
  }

  const sent = Number(data.sent_count ?? 0);
  await respondToUrl(responseUrl, {
    replace_original: true,
    text: "Follow-ups stopped",
    blocks: [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:octagonal_sign: Follow-ups for `
          + `${SHOW_FULL_PHONE ? data.phone : maskPhone(String(data.phone))} were stopped by `
          + `<@${operator.slack_user_id}> after ${sent} text${sent === 1 ? "" : "s"}.`,
      },
    }],
  });
  return new Response("", { status: 200 });
}

async function handleModalSubmit(payload: Record<string, unknown>): Promise<Response> {
  const user = payload.user as { id: string; name?: string };
  const operator = await loadOperator(user.id);
  if (!operator) {
    return json({
      response_action: "errors",
      errors: { phone: "You are not set up to send client follow-ups." },
    });
  }

  const view = payload.view as {
    state: { values: Record<string, Record<string, Record<string, unknown>>> };
    private_metadata: string;
  };
  const values = view.state.values;
  const read = (block: string) => values?.[block]?.value;

  const phone = String((read("phone") as { value?: string })?.value ?? "").trim();
  const firstName = String((read("first_name") as { value?: string })?.value ?? "").trim();
  const caseReference = String((read("case_reference") as { value?: string })?.value ?? "").trim();
  const language = (read("language") as { selected_option?: { value: string } })?.selected_option?.value ?? "en";
  const sequenceSlug = (read("sequence") as { selected_option?: { value: string } })?.selected_option?.value;
  const assignee = (read("assignee") as { selected_user?: string })?.selected_user ?? user.id;

  let channelId = "";
  try {
    channelId = JSON.parse(view.private_metadata ?? "{}").channel_id ?? "";
  } catch { /* the modal can still succeed without a channel to announce in */ }

  const { data, error } = await supabase.rpc("followup_enroll", {
    payload: {
      phone,
      language,
      first_name: firstName || null,
      sequence_slug: sequenceSlug,
      assigned_slack_user_id: assignee,
      started_by_slack_user_id: user.id,
      slack_channel_id: channelId || null,
      case_reference: caseReference || null,
    },
  });

  if (error) {
    console.error("followup_enroll failed", error);
    return json({ response_action: "errors", errors: { phone: "Something went wrong. Try again." } });
  }

  // Field-level errors keep the form open with the number still typed in, which
  // is the difference between a two-second fix and starting over.
  if (!data?.ok) {
    const messages: Record<string, string> = {
      invalid_phone: "That does not read as a mobile number. Try 512-555-0123.",
      already_active: "This client already has a series running.",
      opted_out: "This client has opted out of texts.",
      no_steps: "That sequence has no texts in it yet.",
      sequence_inactive: "That sequence is paused.",
      sequence_not_found: "That sequence no longer exists.",
    };
    const field = data?.reason === "no_steps" || data?.reason === "sequence_inactive"
      || data?.reason === "sequence_not_found" ? "sequence" : "phone";
    return json({
      response_action: "errors",
      errors: { [field]: messages[data?.reason as string] ?? "The series could not be started." },
    });
  }

  const sequences = await loadSequences();
  const timezone = sequences.find((sequence) => sequence.slug === data.sequence?.slug)?.timezone
    ?? "America/Chicago";
  await announceEnrollment({ ...data, case_reference: caseReference || null }, channelId, timezone, null);
  return new Response("", { status: 200 });
}

async function handleInteractivity(payload: Record<string, unknown>): Promise<Response> {
  if (payload.type === "view_submission") {
    if ((payload.view as { callback_id?: string })?.callback_id === "followup_start") {
      return handleModalSubmit(payload);
    }
    return new Response("", { status: 200 });
  }

  if (payload.type === "block_actions") {
    const action = (payload.actions as Array<{ action_id: string }>)?.[0];
    if (action?.action_id === "followup_stop") return handleStopButton(payload);
  }

  return new Response("", { status: 200 });
}

// ------------------------------------------------------------------ entry

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = await request.text();
  const verified = await verifySlackRequest(request, rawBody);
  if (!verified.ok) {
    console.warn("Rejected a Slack request:", verified.reason);
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const params = new URLSearchParams(rawBody);
    const payload = params.get("payload");
    if (payload) return await handleInteractivity(JSON.parse(payload));
    return await handleCommand(params);
  } catch (error) {
    console.error("followups-slack failed", error);
    return ephemeral(":warning: Something went wrong. The error has been logged.");
  }
});
