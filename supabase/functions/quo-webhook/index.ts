// Inbound Quo events: replies, opt-outs, call-backs, and delivery receipts.
//
//   supabase functions deploy quo-webhook --no-verify-jwt
//
// Register the URL in Quo for at least message.received. Add message.delivered
// and the call events to get delivery receipts and call-back detection too.
//
// Anything the client does — texting back, texting STOP, or calling the office —
// stops their series. That is the whole point: nobody should keep getting drip
// texts after they have re-engaged.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { classifyInbound, type Language, START_CONFIRMATION, STOP_CONFIRMATION } from "../_shared/copy.ts";
import { readEvent, readPhone, sendText, verifyWebhook } from "../_shared/quo.ts";
import { json, maskPhone, notifyChannel } from "../_shared/slack.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const SHOW_FULL_PHONE = (Deno.env.get("SLACK_SHOW_FULL_PHONE") ?? "false") === "true";

// Carriers registered for A2P 10DLC usually auto-reply to STOP themselves. Our
// own confirmation is on by default because a missing confirmation is a
// compliance problem, while a duplicate one is only noise. Set this to "false"
// if you can see Quo already sending one.
const SEND_STOP_CONFIRMATION = (Deno.env.get("SEND_STOP_CONFIRMATION") ?? "true") === "true";

function display(phone: string): string {
  return SHOW_FULL_PHONE ? phone : maskPhone(phone);
}

async function confirmTo(phone: string, from: string | null, text: string) {
  const sender = from ?? Deno.env.get("QUO_PHONE_NUMBER_ID") ?? Deno.env.get("QUO_FROM_NUMBER") ?? "";
  if (!sender) {
    console.warn("No sending number available for the confirmation text.");
    return;
  }
  const result = await sendText({ to: phone, from: sender, content: text });
  if (!result.ok) console.error("Confirmation text failed", result.error);
}

async function handleInboundMessage(object: Record<string, unknown>) {
  const from = readPhone(object.from);
  const to = readPhone(object.to);
  const body = String(object.body ?? object.text ?? "");
  const messageId = object.id ? String(object.id) : null;

  if (!from) {
    console.warn("Inbound message with no sender; ignoring.");
    return { ignored: "no_sender" };
  }

  const { isStop, isStart } = classifyInbound(body);

  const { data, error } = await supabase.rpc("followup_record_inbound", {
    payload: {
      phone: from,
      body,
      kind: "message",
      quo_message_id: messageId,
      quo_phone_number_id: object.phoneNumberId ? String(object.phoneNumberId) : null,
      from_number: from,
      to_number: to,
      is_stop: isStop,
      is_start: isStart,
    },
  });

  if (error) {
    console.error("followup_record_inbound failed", error);
    return { error: error.message };
  }
  if (data?.duplicate) return { duplicate: true };
  if (!data?.ok) return { ignored: data?.reason };

  const language = (data.language === "es" ? "es" : "en") as Language;
  const who = data.first_name ? `${data.first_name} (${display(from)})` : display(from);
  const assigned = data.assigned_slack_user_id ? ` <@${data.assigned_slack_user_id}>` : "";

  if (data.action === "opt_out") {
    if (SEND_STOP_CONFIRMATION) await confirmTo(from, to, STOP_CONFIRMATION[language]);
    await notifyChannel(
      data.slack_channel_id as string,
      `:no_entry: ${who} texted *STOP*. They are unsubscribed and any running series has been stopped.${assigned}`,
    );
    return { action: "opt_out" };
  }

  if (data.action === "opt_in") {
    await confirmTo(from, to, START_CONFIRMATION[language]);
    await notifyChannel(
      data.slack_channel_id as string,
      `:white_check_mark: ${who} texted *START* and can receive texts again.`,
    );
    return { action: "opt_in" };
  }

  // An ordinary reply. This is the outcome the whole system exists to produce,
  // so it goes to the channel with the message body in full.
  const stopped = data.stopped as Record<string, unknown> | null;
  const wasRunning = Boolean(stopped?.ok);
  await notifyChannel(
    data.slack_channel_id as string,
    `:tada: ${who} replied${wasRunning ? " — follow-ups stopped" : ""}.${assigned}`,
    [
      {
        type: "section",
        text: { type: "mrkdwn", text: `:tada: *${who} replied*${assigned}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `>${body.slice(0, 2500).replace(/\n/g, "\n>")}` },
      },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: wasRunning
            ? `Follow-ups stopped after ${stopped?.sent_count ?? 0} text(s). Someone should reply in Quo.`
            : "No series was running for this number.",
        }],
      },
    ],
  );
  return { action: "reply", stopped: wasRunning };
}

async function handleInboundCall(object: Record<string, unknown>) {
  const direction = String(object.direction ?? "");
  // Only a call *from* the client counts as re-engagement. Our own outbound
  // attempts, which are the reason the series exists, must not stop it.
  if (direction && direction !== "incoming" && direction !== "inbound") {
    return { ignored: "outgoing_call" };
  }

  const from = readPhone(object.from);
  if (!from) return { ignored: "no_caller" };

  const { data, error } = await supabase.rpc("followup_record_inbound", {
    payload: { phone: from, kind: "call", is_stop: false, is_start: false },
  });
  if (error) {
    console.error("followup_record_inbound failed for a call", error);
    return { error: error.message };
  }
  if (!data?.ok) return { ignored: data?.reason };

  const stopped = data.stopped as Record<string, unknown> | null;
  if (!stopped?.ok) return { action: "call", stopped: false };

  const who = data.first_name ? `${data.first_name} (${display(from)})` : display(from);
  await notifyChannel(
    data.slack_channel_id as string,
    `:telephone_receiver: ${who} called back — follow-ups stopped after `
      + `${stopped.sent_count ?? 0} text(s).`
      + (data.assigned_slack_user_id ? ` <@${data.assigned_slack_user_id}>` : ""),
  );
  return { action: "call", stopped: true };
}

async function handleDelivery(object: Record<string, unknown>, status: string) {
  const messageId = object.id ? String(object.id) : null;
  if (!messageId) return { ignored: "no_message_id" };

  const { data, error } = await supabase.rpc("followup_record_delivery", {
    payload: {
      quo_message_id: messageId,
      status,
      error: object.error ? String(object.error) : null,
    },
  });
  if (error) {
    console.error("followup_record_delivery failed", error);
    return { error: error.message };
  }
  return data;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = await request.text();
  const verified = await verifyWebhook(request, rawBody);
  if (!verified.ok) {
    console.warn("Rejected a Quo webhook:", verified.reason);
    return new Response("Unauthorized", { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "Body was not JSON." }, 400);
  }

  const { type, object } = readEvent(body);

  try {
    // message.received is the only event that is strictly required; the rest
    // sharpen the picture when they are switched on in Quo.
    if (type === "message.received" || (!type && object.direction === "incoming")) {
      return json(await handleInboundMessage(object));
    }
    if (type === "message.delivered") return json(await handleDelivery(object, "delivered"));
    if (type === "message.failed" || type === "message.undelivered") {
      return json(await handleDelivery(object, "undelivered"));
    }
    if (type.startsWith("call.")) return json(await handleInboundCall(object));

    // Unknown events are acknowledged rather than rejected, so Quo does not
    // retry something we will never handle.
    return json({ ignored: type || "unknown_event" });
  } catch (error) {
    console.error("quo-webhook failed", error);
    return json({ error: (error as Error).message }, 500);
  }
});
